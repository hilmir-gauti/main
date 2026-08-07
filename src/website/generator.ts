/**
 * Static website generator.
 *
 * Produces a complete, self-contained site per tenant: one HTML file with
 * inlined CSS and JS, plus sitemap and robots. No build step, no framework, no
 * external requests — the output can be served from this platform, uploaded to
 * any host, or handed to the customer if they ever leave.
 *
 * Every design variant is generated from the same content so the operator can
 * compare finished pages rather than imagine them.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { all, get, run, transaction } from '../core/db.ts';
import { escapeHtml, html, jsonScript, raw, type SafeHtml } from '../core/html.ts';
import { formatISK, normalizePhone } from '../core/iceland.ts';
import { id, slugify } from '../core/ids.ts';
import { logger } from '../core/logger.ts';
import { formatDurationIs, minutesToHhmm, type Weekday } from '../core/time.ts';
import { config } from '../config.ts';
import { listServices, listStaff } from '../domain/catalog.ts';
import { industryPreset } from '../domain/industries.ts';
import { flowForIndustry } from '../domain/intake/flows.ts';
import { weeklyHoursMap } from '../domain/schedule.ts';
import { formatAddress, getTenantOrThrow } from '../domain/tenants.ts';
import type { Service, Staff, Tenant } from '../domain/types.ts';
import { buildPalette, variantByKey, variantsForIndustry, type Palette, type Variant } from './theme.ts';
import { heroMotif, motionScript, motionStyles } from './motion.ts';
import { resolveBrandColor } from './palette-defaults.ts';
import { bookingWidgetScript, bookingWidgetStyles } from './widget.ts';

/** E.164 is what we store and dial; "555 1234" is what Icelanders read. */
function phoneDisplay(phone: string): string {
  const info = normalizePhone(phone);
  return info.valid ? info.display : phone;
}

const WEEKDAY_NAMES: Record<Weekday, string> = {
  1: 'Mánudagur', 2: 'Þriðjudagur', 3: 'Miðvikudagur', 4: 'Fimmtudagur',
  5: 'Föstudagur', 6: 'Laugardagur', 7: 'Sunnudagur',
};

const SCHEMA_WEEKDAYS: Record<Weekday, string> = {
  1: 'Monday', 2: 'Tuesday', 3: 'Wednesday', 4: 'Thursday',
  5: 'Friday', 6: 'Saturday', 7: 'Sunday',
};

export interface SiteContent {
  tenant: Tenant;
  services: Service[];
  staff: Staff[];
  hours: Record<Weekday, Array<{ openMin: number; closeMin: number }>>;
  /** Overrides the tenant's stored copy, e.g. AI-generated text from the wizard. */
  tagline?: string;
  about?: string;
}

export function loadSiteContent(tenantId: string, overrides: { tagline?: string; about?: string } = {}): SiteContent {
  const tenant = getTenantOrThrow(tenantId);
  return {
    tenant,
    services: listServices(tenantId, { publicOnly: true }),
    staff: listStaff(tenantId, { bookableOnly: true }),
    hours: weeklyHoursMap(tenantId, null),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Page sections
// ---------------------------------------------------------------------------

function hoursTable(content: SiteContent): SafeHtml {
  const rows = ([1, 2, 3, 4, 5, 6, 7] as Weekday[]).map((weekday) => {
    const windows = content.hours[weekday];
    const text = windows.length === 0
      ? 'Lokað'
      : windows.map((w) => `${minutesToHhmm(w.openMin)}–${minutesToHhmm(w.closeMin)}`).join(', ');
    return html`
      <tr>
        <th scope="row">${WEEKDAY_NAMES[weekday]}</th>
        <td class="${windows.length === 0 ? 'closed' : ''}">${text}</td>
      </tr>`;
  });

  return html`<table class="hours"><tbody>${rows}</tbody></table>`;
}

function servicesSection(content: SiteContent, variant: Variant): SafeHtml {
  const { services } = content;
  if (services.length === 0) return html``;

  const priceText = (service: Service) => (service.priceIsk > 0 ? formatISK(service.priceIsk) : 'Verð eftir umfangi');

  if (variant.layout.services === 'spjold') {
    return html`
      <div class="grid grid-services">
        ${services.map(
          (service, index) => html`
            <article class="service-card">
              <span class="num">${String(index + 1).padStart(2, '0')}</span>
              <h3>${service.name}</h3>
              ${service.description ? html`<p>${service.description}</p>` : ''}
              <div class="service-meta">
                <span class="price">${priceText(service)}</span>
                <span class="duration">${formatDurationIs(service.durationMin)}</span>
              </div>
            </article>`,
        )}
      </div>`;
  }

  if (variant.layout.services === 'listi') {
    return html`
      <div class="service-list">
        ${services.map(
          (service) => html`
            <div class="service-item">
              <div class="meta">
                <strong>${service.name}</strong>
                ${service.description ? html`<p>${service.description}</p>` : ''}
                <span class="duration">${formatDurationIs(service.durationMin)}</span>
              </div>
              <span class="price">${priceText(service)}</span>
            </div>`,
        )}
      </div>`;
  }

  return html`
    <div class="price-list">
      ${services.map(
        (service) => html`
          <div class="service-row">
            <span class="name">
              ${service.name}
              ${service.description ? html`<small>${service.description}</small>` : ''}
            </span>
            <span class="dots"></span>
            <span class="price">${priceText(service)}</span>
          </div>`,
      )}
    </div>`;
}

/**
 * A moving band of what the business does.
 *
 * Built from the service names it already has, so it states nothing new — the
 * job is rhythm. Every generated page is otherwise a stack of centred sections
 * in a single column, and one horizontal element breaks that.
 *
 * The track holds the list twice: the animation translates by exactly half its
 * width, which lands on an identical frame, so the loop has no seam.
 */
function marquee(content: SiteContent): SafeHtml {
  const preset = industryPreset(content.tenant.industry);

  const words = content.services.length >= 3
    ? content.services.map((service) => service.name)
    : [preset.label, ...content.services.map((service) => service.name)];

  if (words.length < 3) return html``;

  const run = html`<div class="marquee-run">${words.map((word) => html`<span>${word}</span>`)}</div>`;

  return html`
    <div class="marquee" aria-hidden="true">
      <div class="marquee-track">${run}${run}</div>
    </div>`;
}

/**
 * A short row of facts under the hero.
 *
 * Only ever built from things already known — never padded out with invented
 * claims like "20 years of experience", which is the standard filler on
 * generated sites and is a lie the business then has to live with.
 */
function trustStrip(content: SiteContent): SafeHtml {
  const { tenant } = content;
  const preset = industryPreset(tenant.industry);
  const openDays = Object.values(content.hours ?? {}).filter((ranges) => ranges.length > 0).length;

  const stats: Array<{ value: string; label: string }> = [];

  if (content.services.length > 0) {
    stats.push({ value: String(content.services.length), label: 'þjónustuliðir í boði' });
  }
  if (content.staff.length > 0) {
    stats.push({ value: String(content.staff.length), label: preset.defaultStaffTitle.toLowerCase() });
  }
  if (openDays > 0) {
    stats.push({ value: `${openDays}`, label: openDays === 1 ? 'opinn dagur í viku' : 'opnir dagar í viku' });
  }
  stats.push({ value: 'Strax', label: 'staðfesting á bókun' });

  if (stats.length < 3) return html``;

  return html`
    <section class="section" style="border-top:0;padding-top:clamp(1.5rem,4vw,2.5rem)">
      <div class="wrap">
        <div class="stat-strip reveal-stagger">
          ${stats.map((stat) => html`
            <div class="stat"><strong>${stat.value}</strong><span>${stat.label}</span></div>`)}
        </div>
      </div>
    </section>`;
}

/**
 * Questions every booking generates, answered from this tenant's own settings
 * rather than from boilerplate — the cancellation window and the notice period
 * are real numbers the booking engine enforces.
 */
function faqSection(content: SiteContent): SafeHtml {
  const { tenant } = content;
  const preset = industryPreset(tenant.industry);

  const items: Array<{ q: string; a: SafeHtml }> = [
    {
      q: 'Hvernig bóka ég tíma?',
      a: html`<p>Veldu þjónustu og lausan tíma hér að ofan. Þú færð staðfestingu í tölvupósti um leið og
              bókunin er skráð${tenant.phone ? html`, eða hringdu í ${phoneDisplay(tenant.phone)}` : ''}.</p>`,
    },
    {
      q: 'Hvað ef ég kemst ekki?',
      a: html`<p>Afbókaðu með minnst ${tenant.cancelWindowHours} klukkustunda fyrirvara. Tengill til að
              afbóka fylgir staðfestingarpóstinum, svo þú þarft ekki að hringja.</p>`,
    },
  ];

  if (tenant.minNoticeMin > 0) {
    items.push({
      q: 'Get ég bókað með stuttum fyrirvara?',
      a: html`<p>Lausir tímar birtast frá ${formatDurationIs(tenant.minNoticeMin)} fram í tímann.
              Vantar þig fyrr${tenant.phone ? html`, hringdu í ${phoneDisplay(tenant.phone)}` : ''} — það er
              oft hægt að finna lausn.</p>`,
    });
  }

  if (content.staff.length > 1) {
    items.push({
      q: `Get ég valið hvaða ${preset.defaultStaffTitle.toLowerCase()} tekur á móti mér?`,
      a: html`<p>Já. Veldu nafn í bókunarferlinu, eða slepptu því og þá fyllum við í fyrsta lausa tímann.</p>`,
    });
  }

  return html`
    <section class="section" id="spurningar">
      <div class="wrap">
        <div class="section-title reveal">
          <h2>Algengar spurningar</h2>
        </div>
        <div class="faq reveal-stagger">
          ${items.map((item) => html`
            <details>
              <summary>${item.q}</summary>
              ${item.a}
            </details>`)}
        </div>
      </div>
    </section>`;
}

function heroSection(content: SiteContent, variant: Variant, palette: Palette): SafeHtml {
  const { tenant } = content;
  const tagline = content.tagline || tenant.tagline;
  const preset = industryPreset(tenant.industry);
  const address = formatAddress(tenant);

  // Sits behind the copy in every variant. The blobs are animated, the motif
  // is per-trade, and both are decorative — hidden from assistive tech.
  const backdrop = html`
    <div class="hero-aura" aria-hidden="true"><span></span><span></span><span></span></div>
    ${raw(heroMotif(preset.template, palette))}`;

  const actions = html`
    <div class="hero-actions">
      <a class="btn btn-primary" href="#bokun">${preset.bookVerb}</a>
      ${tenant.phone ? html`<a class="btn btn-ghost" href="tel:${tenant.phone}">Hringja ${phoneDisplay(tenant.phone)}</a>` : ''}
    </div>`;

  if (variant.layout.hero === 'skipt') {
    const badges = [
      content.services[0]?.name,
      address ? address.split(',')[0] : '',
      tenant.phone ? phoneDisplay(tenant.phone) : '',
    ].filter(Boolean) as string[];

    return html`
      <header class="hero hero-${variant.layout.hero}">
        ${backdrop}
        <div class="hero-grid">
          <div class="hero-copy">
            <p class="eyebrow">${preset.label}</p>
            <h1>${tenant.name}</h1>
            <p class="lead">${tagline}</p>
            ${actions}
          </div>
          <div class="hero-panel">
            <div class="badge-stack">${badges.map((badge) => html`<div>${badge}</div>`)}</div>
          </div>
        </div>
      </header>`;
  }

  if (variant.layout.hero === 'mynd') {
    return html`
      <header class="hero hero-${variant.layout.hero}">
        ${backdrop}
        <div class="wrap">
          <div class="hero-inner">
            <p class="eyebrow">${preset.label}${address ? ` · ${address.split(',').pop()?.trim()}` : ''}</p>
            <h1>${tenant.name}</h1>
            <p class="lead">${tagline}</p>
            ${actions}
          </div>
        </div>
      </header>`;
  }

  return html`
    <header class="hero hero-${variant.layout.hero}">
      ${backdrop}
      <div class="wrap">
        <p class="eyebrow">${preset.label}</p>
        <h1>${tenant.name}</h1>
        <div class="rule"></div>
        <p class="lead">${tagline}</p>
        ${actions}
      </div>
    </header>`;
}

/**
 * LocalBusiness structured data. This is what puts opening hours and a booking
 * link in a Google result — for a small Icelandic business it is often worth
 * more than the page itself.
 */
function structuredData(content: SiteContent, siteUrl: string): SafeHtml {
  const { tenant } = content;

  const openingHours = ([1, 2, 3, 4, 5, 6, 7] as Weekday[])
    .flatMap((weekday) =>
      content.hours[weekday].map((window) => ({
        '@type': 'OpeningHoursSpecification',
        dayOfWeek: `https://schema.org/${SCHEMA_WEEKDAYS[weekday]}`,
        opens: minutesToHhmm(window.openMin),
        closes: minutesToHhmm(window.closeMin),
      })),
    );

  const data: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    name: tenant.name,
    description: content.about || tenant.about,
    url: siteUrl,
    ...(tenant.phone ? { telephone: tenant.phone } : {}),
    ...(tenant.email ? { email: tenant.email } : {}),
    ...(tenant.address
      ? {
          address: {
            '@type': 'PostalAddress',
            streetAddress: tenant.address,
            postalCode: tenant.postcode,
            addressLocality: tenant.city,
            addressCountry: 'IS',
          },
        }
      : {}),
    ...(openingHours.length ? { openingHoursSpecification: openingHours } : {}),
    ...(content.services.length
      ? {
          hasOfferCatalog: {
            '@type': 'OfferCatalog',
            name: 'Þjónusta',
            itemListElement: content.services.map((service) => ({
              '@type': 'Offer',
              itemOffered: { '@type': 'Service', name: service.name, description: service.description },
              ...(service.priceIsk > 0 ? { price: String(service.priceIsk), priceCurrency: 'ISK' } : {}),
            })),
          },
        }
      : {}),
    currenciesAccepted: 'ISK',
    areaServed: { '@type': 'Country', name: 'Ísland' },
  };

  return html`<script type="application/ld+json">${jsonScript(data)}</script>`;
}

/** Inline SVG favicon built from the business's initial and brand colour. */
function faviconDataUri(tenant: Tenant, palette: Palette): string {
  const initial = escapeHtml((tenant.name.trim()[0] ?? 'R').toUpperCase());
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${palette.brand}"/><text x="32" y="44" font-family="system-ui,sans-serif" font-size="34" font-weight="700" text-anchor="middle" fill="${palette.onBrand}">${initial}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// ---------------------------------------------------------------------------
// Full page
// ---------------------------------------------------------------------------

export interface RenderOptions {
  variantKey: string;
  /** Base URL the booking API is served from. */
  apiBase?: string;
  /** Rendered into a banner; used for wizard previews. */
  previewNotice?: string;
}

export function renderSite(content: SiteContent, options: RenderOptions): string {
  const { tenant } = content;
  const variant = variantByKey(options.variantKey);
  const brandColor = resolveBrandColor(tenant.brandColor, tenant.industry);
  const light = buildPalette(brandColor, false);
  const dark = buildPalette(brandColor, true);
  const preset = industryPreset(tenant.industry);

  const siteUrl = tenant.websiteDomain ? `https://${tenant.websiteDomain}` : `${config.baseUrl}/v/${tenant.slug}`;
  const apiBase = options.apiBase ?? `${config.baseUrl}/api/vefur`;
  const about = content.about || tenant.about;
  const address = formatAddress(tenant);
  const mapQuery = encodeURIComponent(`${tenant.name} ${address}`.trim());

  const page = html`<!doctype html>
<html lang="is">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${tenant.name}${tenant.city ? ` — ${tenant.city}` : ''}</title>
<meta name="description" content="${(content.tagline || tenant.tagline || about).slice(0, 160)}">
<meta name="theme-color" content="${light.brand}">
<link rel="icon" href="${faviconDataUri(tenant, light)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${tenant.name}">
<meta property="og:description" content="${(content.tagline || tenant.tagline).slice(0, 200)}">
<meta property="og:locale" content="is_IS">
<meta property="og:url" content="${siteUrl}">
<link rel="canonical" href="${siteUrl}">
<style>
:root{
  --brand:${light.brand}; --brand-dark:${light.brandDark}; --brand-light:${light.brandLight};
  --on-brand:${light.onBrand}; --ink:${light.ink}; --muted:${light.muted};
  --surface:${light.surface}; --surface-alt:${light.surfaceAlt}; --border:${light.border};
  --corner:${variant.layout.corner}; --width:${variant.layout.width};
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark){
  :root{
    --brand:${dark.brand}; --brand-dark:${dark.brandDark}; --brand-light:${dark.brandLight};
    --on-brand:${dark.onBrand}; --ink:${dark.ink}; --muted:${dark.muted};
    --surface:${dark.surface}; --surface-alt:${dark.surfaceAlt}; --border:${dark.border};
  }
}
*{box-sizing:border-box}
body{margin:0;background:var(--surface);color:var(--ink);
     font-family:${raw(variant.fonts.body)};line-height:1.65;-webkit-font-smoothing:antialiased}
h1,h2,h3{font-family:${raw(variant.fonts.heading)};line-height:1.2;margin:0 0 .6rem}
h2{font-size:clamp(1.6rem,3.5vw,2.2rem)}
h3{font-size:1.15rem}
p{margin:0 0 1rem}
a{color:var(--brand)}
.wrap{max-width:var(--width);margin-inline:auto;padding-inline:clamp(1.1rem,4vw,2rem)}
.eyebrow{text-transform:uppercase;letter-spacing:.12em;font-size:.78rem;font-weight:700;color:var(--brand);margin:0 0 .5rem}
.lead{font-size:clamp(1.05rem,2vw,1.25rem);color:var(--muted)}
.section{padding-block:clamp(3rem,7vw,4.5rem);border-top:1px solid var(--border)}
.section-title{margin-bottom:2rem;max-width:42rem}
.section-title p{color:var(--muted);margin:0}
.grid{display:grid;gap:1rem}
.grid-services{grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}
.grid-two{grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:2.5rem}
.btn{display:inline-block;padding:.85rem 1.6rem;border-radius:10px;text-decoration:none;font-weight:600;
     border:1px solid transparent;cursor:pointer}
.btn-primary{background:var(--brand);color:var(--on-brand)}
.btn-primary:hover{background:var(--brand-dark)}
.btn-ghost{border-color:currentColor;color:inherit;opacity:.9}
.btn-ghost:hover{opacity:1}
.hero-actions{display:flex;flex-wrap:wrap;gap:.75rem;margin-top:1.5rem}
.service-meta{display:flex;justify-content:space-between;align-items:baseline;gap:1rem;margin-top:.75rem;
              font-size:.92rem}
.service-meta .duration,.service-item .duration,.service-row small{color:var(--muted)}
.service-row .name{display:flex;flex-direction:column}
.service-row small{font-size:.85rem}
.service-item p{margin:.15rem 0 .3rem;color:var(--muted);font-size:.92rem}
.hours{width:100%;border-collapse:collapse}
.hours th{text-align:left;font-weight:500;padding:.5rem 0;color:var(--muted)}
.hours td{text-align:right;padding:.5rem 0;font-variant-numeric:tabular-nums}
.hours td.closed{color:var(--muted)}
.hours tr+tr th,.hours tr+tr td{border-top:1px solid var(--border)}
.panel{background:var(--surface-alt);border:1px solid var(--border);border-radius:var(--corner);padding:1.5rem}
.staff-list{display:flex;flex-wrap:wrap;gap:.6rem;list-style:none;padding:0;margin:0}
.staff-list li{background:var(--surface-alt);border:1px solid var(--border);border-radius:999px;padding:.45rem 1rem;font-size:.92rem}
.booking-shell{background:var(--surface-alt);border:1px solid var(--border);border-radius:var(--corner);
               padding:clamp(1.25rem,4vw,2.25rem)}
footer{border-top:1px solid var(--border);padding-block:2.5rem;color:var(--muted);font-size:.9rem}
.footer-grid{display:flex;flex-wrap:wrap;gap:1rem 2.5rem;justify-content:space-between}
${options.previewNotice ? raw('.preview-banner{background:#0f172a;color:#fff;text-align:center;padding:.6rem 1rem;font-size:.88rem}') : ''}
${raw(variant.css(light))}
${raw(motionStyles(light))}
${raw(bookingWidgetStyles())}
@media (max-width:640px){ .hero-actions .btn{flex:1;text-align:center} }
</style>
</head>
<body>
<div class="grain" aria-hidden="true"></div>
<div class="progress" aria-hidden="true"></div>
${options.previewNotice ? html`<div class="preview-banner">${options.previewNotice}</div>` : ''}

<nav class="sitenav">
  <div class="wrap sitenav-inner">
    <a class="brandmark" href="#top"><span class="dot"></span>${tenant.name}</a>
    <ul class="navlinks">
      ${content.services.length > 0 ? html`<li><a href="#thjonusta">Þjónusta</a></li>` : ''}
      <li><a href="#um-okkur">Um okkur</a></li>
      <li><a href="#hafa-samband">Hafa samband</a></li>
    </ul>
    <a class="btn btn-primary btn-sm nav-cta" href="#bokun">${preset.bookVerb}</a>
  </div>
</nav>

<div id="top"></div>
${heroSection(content, variant, light)}

<main>
  ${trustStrip(content)}

  ${marquee(content)}

  ${content.services.length > 0
    ? html`
      <section class="section" id="thjonusta">
        <div class="wrap">
          <div class="section-title reveal">
            <h2>Þjónusta</h2>
            <p>Verð eru með virðisaukaskatti. Hafðu samband ef þú finnur ekki það sem þig vantar.</p>
          </div>
          <div class="reveal-stagger">${servicesSection(content, variant)}</div>
        </div>
      </section>`
    : ''}

  <section class="section section-dark" id="bokun">
    <div class="wrap">
      <div class="section-title reveal">
        <h2>${preset.bookVerb}</h2>
        <p>Veldu tíma sem hentar þér. Þú færð staðfestingu strax.</p>
      </div>
      <div class="booking-shell reveal">
        <div id="rth-bokun" data-api="${apiBase}" data-slug="${tenant.slug}"></div>
      </div>
    </div>
  </section>

  <section class="section" id="um-okkur">
    <div class="wrap">
      <div class="grid grid-two reveal-stagger">
        <div>
          <h2>Um okkur</h2>
          <p>${about}</p>
          ${content.staff.length > 0
            ? html`
              <h3>Starfsfólk</h3>
              <ul class="staff-list">
                ${content.staff.map((member) => html`<li>${member.name}${member.title ? ` · ${member.title}` : ''}</li>`)}
              </ul>`
            : ''}
        </div>
        <div>
          <div class="panel">
            <h3>Opnunartími</h3>
            ${hoursTable(content)}
          </div>
        </div>
      </div>
    </div>
  </section>

  <section class="section" id="hafa-samband">
    <div class="wrap">
      <div class="grid grid-two reveal-stagger">
        <div>
          <h2>Hafa samband</h2>
          ${tenant.phone ? html`<p><strong>Sími:</strong> <a href="tel:${tenant.phone}">${phoneDisplay(tenant.phone)}</a></p>` : ''}
          ${tenant.email ? html`<p><strong>Netfang:</strong> <a href="mailto:${tenant.email}">${tenant.email}</a></p>` : ''}
          ${address
            ? html`<p><strong>Heimilisfang:</strong><br>${address}<br>
                     <a href="https://www.google.com/maps/search/?api=1&query=${raw(mapQuery)}" rel="noopener" target="_blank">Sjá á korti</a></p>`
            : ''}
        </div>
        <div>
          <div class="panel">
            <h3>Afbókun</h3>
            <p>Láttu okkur vita með minnst ${tenant.cancelWindowHours} klukkustunda fyrirvara ef þú kemst ekki.
               Þú getur afbókað með tenglinum í staðfestingarpóstinum.</p>
          </div>
        </div>
      </div>
    </div>
  </section>
  ${faqSection(content)}
</main>

<div class="cta-bar">
  <a class="btn btn-primary" href="#bokun">${preset.bookVerb}</a>
  ${tenant.phone ? html`<a class="btn btn-ghost" href="tel:${tenant.phone}">Hringja</a>` : ''}
</div>

<footer>
  <div class="wrap footer-grid">
    <span>© ${new Date().getFullYear()} ${tenant.name}${tenant.kennitala ? ` · kt. ${tenant.kennitala}` : ''}</span>
    <span>Vefur og bókanir: Rafræn Þjónusta</span>
  </div>
</footer>

${structuredData(content, siteUrl)}
<script>${raw(motionScript())}</script>
<script>${raw(bookingWidgetScript())}</script>
</body>
</html>`;

  return page.value;
}

// ---------------------------------------------------------------------------
// Writing to disk
// ---------------------------------------------------------------------------

export interface BuiltVariant {
  variant: string;
  label: string;
  description: string;
  path: string;
  bytes: number;
  previewUrl: string;
}

function siteRoot(tenant: Tenant): string {
  return join(config.sitesDir, slugify(tenant.slug));
}

/**
 * Renders every design variant into its own preview folder and records them,
 * so the wizard can show finished pages side by side.
 */
export function generateVariants(tenantId: string, overrides: { tagline?: string; about?: string } = {}): BuiltVariant[] {
  const content = loadSiteContent(tenantId, overrides);
  const { tenant } = content;
  const variants = variantsForIndustry(tenant.industry);
  const built: BuiltVariant[] = [];

  transaction(() => {
    run('DELETE FROM website_variant WHERE tenant_id = ?', tenantId);

    for (const variant of variants) {
      const markup = renderSite(content, {
        variantKey: variant.key,
        previewNotice: `Forskoðun · ${variant.label} — svona lítur síðan út fyrir viðskiptavini`,
      });

      const directory = join(siteRoot(tenant), 'forskodun', variant.key);
      mkdirSync(directory, { recursive: true });
      const filePath = join(directory, 'index.html');
      writeFileSync(filePath, markup, 'utf8');

      run(
        `INSERT INTO website_variant (id, tenant_id, variant, label, description, path, bytes, chosen, built_at)
         VALUES (?,?,?,?,?,?,?,0,?)`,
        id('vef'),
        tenantId,
        variant.key,
        variant.label,
        variant.description,
        filePath,
        Buffer.byteLength(markup),
        Date.now(),
      );

      built.push({
        variant: variant.key,
        label: variant.label,
        description: variant.description,
        path: filePath,
        bytes: Buffer.byteLength(markup),
        previewUrl: `${config.baseUrl}/forskodun/${tenantId}/${variant.key}/`,
      });
    }
  });

  logger.info('Vefútgáfur byggðar', { tenantId, variants: built.length });
  return built;
}

export interface VariantRow {
  id: string;
  variant: string;
  label: string;
  description: string;
  path: string;
  bytes: number;
  chosen: number;
  built_at: number;
}

export function listVariants(tenantId: string): VariantRow[] {
  return all<VariantRow>('SELECT * FROM website_variant WHERE tenant_id = ? ORDER BY built_at, variant', tenantId);
}

export function chosenVariant(tenantId: string): VariantRow | null {
  return get<VariantRow>('SELECT * FROM website_variant WHERE tenant_id = ? AND chosen = 1', tenantId);
}

/**
 * Publishes one variant as the live site: re-renders it without the preview
 * banner and writes it, plus sitemap and robots, to the published folder.
 */
export function publishVariant(tenantId: string, variantKey: string, overrides: { tagline?: string; about?: string } = {}): { path: string; bytes: number; url: string } {
  const content = loadSiteContent(tenantId, overrides);
  const { tenant } = content;
  const variant = variantByKey(variantKey);

  const markup = renderSite(content, { variantKey: variant.key });
  const directory = join(siteRoot(tenant), 'vefur');

  // Rebuild from scratch so a removed page cannot linger.
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });

  const filePath = join(directory, 'index.html');
  writeFileSync(filePath, markup, 'utf8');

  const siteUrl = tenant.websiteDomain ? `https://${tenant.websiteDomain}` : `${config.baseUrl}/v/${tenant.slug}`;
  writeFileSync(
    join(directory, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${siteUrl}/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>
</urlset>`,
    'utf8',
  );
  writeFileSync(
    join(directory, 'robots.txt'),
    `User-agent: *\nAllow: /\nSitemap: ${siteUrl}/sitemap.xml\n`,
    'utf8',
  );

  const bytes = Buffer.byteLength(markup);
  const checksum = createHash('sha256').update(markup).digest('hex').slice(0, 16);

  transaction(() => {
    run('UPDATE website_variant SET chosen = 0 WHERE tenant_id = ?', tenantId);
    run('UPDATE website_variant SET chosen = 1 WHERE tenant_id = ? AND variant = ?', tenantId, variant.key);

    const previous = get<{ v: number | null }>('SELECT MAX(version) AS v FROM website_build WHERE tenant_id = ?', tenantId);
    run(
      `INSERT INTO website_build (id, tenant_id, version, path, template, checksum, page_count, bytes, published, built_at)
       VALUES (?,?,?,?,?,?,?,?,1,?)`,
      id('vef'),
      tenantId,
      (previous?.v ?? 0) + 1,
      filePath,
      variant.key,
      checksum,
      1,
      bytes,
      Date.now(),
    );
  });

  logger.info('Vefsíða birt', { tenantId, variant: variant.key, bytes });
  return { path: filePath, bytes, url: siteUrl };
}

export interface BuildRow {
  id: string;
  version: number;
  path: string;
  template: string;
  bytes: number;
  built_at: number;
}

export function latestBuild(tenantId: string): BuildRow | null {
  return get<BuildRow>(
    'SELECT id, version, path, template, bytes, built_at FROM website_build WHERE tenant_id = ? ORDER BY version DESC LIMIT 1',
    tenantId,
  );
}

/** Config the booking widget fetches on load. */
export function widgetConfig(tenantId: string): Record<string, unknown> {
  const tenant = getTenantOrThrow(tenantId);
  const services = listServices(tenantId, { publicOnly: true });
  const flow = flowForIndustry(tenant.industry);

  return {
    tenant: {
      name: tenant.name,
      phone: phoneDisplay(tenant.phone),
      timezone: tenant.timezone,
      cancelWindowHours: tenant.cancelWindowHours,
    },
    services: services.map((service) => ({
      id: service.id,
      name: service.name,
      description: service.description,
      durationMin: service.durationMin,
      priceIsk: service.priceIsk,
    })),
    flow: {
      title: flow.title,
      intro: flow.intro,
      questions: flow.questions,
    },
  };
}
