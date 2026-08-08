/**
 * The webstore half of a generated site: the shelf, the basket and the
 * checkout.
 *
 * Same constraints as the rest of the generator — one self-contained HTML file,
 * no framework, no web font, no network call except to this platform's own
 * order API. Everything below is therefore hand-written CSS and about three
 * hundred lines of plain script.
 *
 * Two decisions are worth knowing before reading:
 *
 * **The shelf is server-rendered, the basket is not.** Every product is in the
 * markup with its price and its stock state, so the page sells even if the
 * script never runs and so search engines see the catalogue. The script only
 * adds the basket on top of that.
 *
 * **Nothing here is trusted.** The basket lives in the visitor's own browser,
 * so its prices are decoration; the server reprices every line from the
 * catalogue when the order arrives.
 */

import { escapeHtml, html, raw, type SafeHtml } from '../core/html.ts';
import { formatISK } from '../core/iceland.ts';
import type { Product, ShopSettings } from '../domain/types.ts';
import type { Palette } from './theme.ts';

// ---------------------------------------------------------------------------
// Generated product art
// ---------------------------------------------------------------------------

/** Stable 32-bit hash, so a product's artwork never changes between builds. */
function seedFrom(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Blends two hex colours. The theme module has its own copy for palette
 * derivation; duplicating six lines here keeps the storefront from importing
 * the theme's internals just to darken a gradient stop.
 */
function mixHex(from: string, to: string, amount: number): string {
  const channels = (hex: string) => {
    const clean = hex.replace('#', '');
    const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
    return [0, 2, 4].map((offset) => Number.parseInt(full.slice(offset, offset + 2), 16) || 0);
  };

  const [r1, g1, b1] = channels(from) as [number, number, number];
  const [r2, g2, b2] = channels(to) as [number, number, number];
  const blend = (a: number, b: number) => Math.max(0, Math.min(255, Math.round(a + (b - a) * amount)));

  return `#${[blend(r1, r2), blend(g1, g2), blend(b1, b2)].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

/** Small deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Artwork for a product with no photograph.
 *
 * A workshop that has just been set up has no product shots, and an empty grey
 * square reads as a broken page. This draws the thing the product is made of
 * instead: grain lines flowing across the panel with a resin river cutting
 * through them, seeded from the product name so every listing looks different
 * and none of them ever changes.
 */
export function grainArt(seedText: string, palette: Palette): string {
  const random = rng(seedFrom(seedText));
  const riverY = 90 + random() * 80;
  const amplitude = 18 + random() * 26;
  const grainCount = 16;

  // Boards are cut from different logs. Tilting the gradient and shifting the
  // base tone per product is what keeps a grid of eight from looking like the
  // same photograph repeated.
  const tilt = (random() * 40 - 20).toFixed(1);
  const light = mixHex(palette.brand, '#ffffff', 0.1 + random() * 0.22);
  const shade = mixHex(palette.brandDark, '#000000', random() * 0.3);

  const lines = Array.from({ length: grainCount }, (_, i) => {
    const y = 12 + i * (236 / grainCount) + random() * 6;
    const bow = (random() - 0.5) * 34;
    const width = 0.6 + random() * 1.5;
    const opacity = (0.10 + random() * 0.22).toFixed(3);
    return `<path d="M-10 ${y.toFixed(1)} C 110 ${(y + bow).toFixed(1)}, 250 ${(y - bow).toFixed(1)}, 410 ${(y + bow / 2).toFixed(1)}"
              stroke-width="${width.toFixed(2)}" opacity="${opacity}"/>`;
  }).join('');

  // Knots: the small closed whorls that make a board look like it came from a
  // tree rather than from a texture pack.
  const knots = Array.from({ length: 2 }, () => {
    const cx = 40 + random() * 320;
    const cy = 30 + random() * 180;
    return Array.from({ length: 3 }, (_, ring) =>
      `<ellipse cx="${cx.toFixed(0)}" cy="${cy.toFixed(0)}" rx="${(5 + ring * 5).toFixed(0)}"
         ry="${(3 + ring * 3).toFixed(0)}" stroke-width="1" opacity="${(0.22 - ring * 0.05).toFixed(2)}"/>`).join('');
  }).join('');

  const river = `M-10 ${riverY.toFixed(1)}
     C 90 ${(riverY - amplitude).toFixed(1)}, 150 ${(riverY + amplitude).toFixed(1)}, 250 ${riverY.toFixed(1)}
     S 360 ${(riverY - amplitude * 0.7).toFixed(1)}, 410 ${(riverY + 6).toFixed(1)}`;

  const id = (seedFrom(seedText) % 100000).toString(36);

  return `<svg class="ware-art" viewBox="0 0 400 250" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id="wood-${id}" x1="0" y1="0" x2="1" y2="1"
                      gradientTransform="rotate(${tilt} 0.5 0.5)">
        <stop offset="0%" stop-color="${shade}"/>
        <stop offset="${(38 + random() * 24).toFixed(0)}%" stop-color="${light}"/>
        <stop offset="100%" stop-color="${shade}"/>
      </linearGradient>
      <linearGradient id="resin-${id}" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="${palette.brandLight}" stop-opacity=".15"/>
        <stop offset="50%" stop-color="${palette.brandLight}" stop-opacity=".75"/>
        <stop offset="100%" stop-color="${palette.brandLight}" stop-opacity=".2"/>
      </linearGradient>
    </defs>
    <rect width="400" height="250" fill="url(#wood-${id})" opacity=".5"/>
    <g stroke="#000" fill="none">${lines}</g>
    <g stroke="#000" fill="none">${knots}</g>
    <path class="ware-river" d="${river}" stroke="url(#resin-${id})" stroke-width="14" fill="none" stroke-linecap="round"/>
    <path class="ware-sheen" d="${river}" stroke="${palette.brandLight}" stroke-width="2" fill="none"
          opacity=".55" stroke-linecap="round"/>
  </svg>`;
}

// ---------------------------------------------------------------------------
// Markup
// ---------------------------------------------------------------------------

/** How a product's availability reads on the shelf. */
function availabilityLabel(product: Product): { text: string; kind: 'til' | 'pontun' | 'uppselt' } {
  if (product.madeToOrder) {
    return {
      text: product.leadTimeDays > 0 ? `Smíðað eftir pöntun · ${product.leadTimeDays} dagar` : 'Smíðað eftir pöntun',
      kind: 'pontun',
    };
  }
  if (product.stock <= 0) return { text: 'Uppselt', kind: 'uppselt' };
  if (product.stock === 1) return { text: 'Eitt eintak til', kind: 'til' };
  return { text: `${product.stock} eintök til`, kind: 'til' };
}

function productCard(product: Product, palette: Palette): SafeHtml {
  const availability = availabilityLabel(product);
  const sellable = availability.kind !== 'uppselt';

  const specs: Array<[string, string]> = [];
  if (product.material) specs.push(['Efni', product.material]);
  if (product.dimensions) specs.push(['Stærð', product.dimensions]);

  return html`
    <article class="ware reveal${sellable ? '' : ' is-sold-out'}"
             data-vara="${product.id}"
             data-flokkur="${product.category}"
             data-heiti="${product.name}"
             data-verd="${product.priceIsk}">
      <div class="ware-visual">
        ${product.imageUrl
          ? html`<img src="${product.imageUrl}" alt="${product.name}" loading="lazy" decoding="async">`
          : raw(grainArt(`${product.id}:${product.name}`, palette))}
        <span class="ware-badge ware-badge-${availability.kind}">${availability.text}</span>
      </div>

      <div class="ware-body">
        <h3>${product.name}</h3>
        ${product.tagline ? html`<p class="ware-tagline">${product.tagline}</p>` : ''}
        ${specs.length > 0
          ? html`<dl class="ware-spec">
              ${specs.map(([label, value]) => html`<div><dt>${label}</dt><dd>${value}</dd></div>`)}
            </dl>`
          : ''}
        ${product.description ? html`<p class="ware-desc">${product.description}</p>` : ''}

        <div class="ware-foot">
          <span class="ware-price">${formatISK(product.priceIsk)}</span>
          ${sellable
            ? html`<button type="button" class="btn btn-primary btn-sm ware-add" data-vara="${product.id}">
                     Setja í körfu
                   </button>`
            : html`<span class="ware-gone">Uppselt</span>`}
        </div>
      </div>
    </article>`;
}

export interface StorefrontContent {
  products: Product[];
  settings: ShopSettings;
  /** Where the order API lives, and which shop this is. */
  apiBase: string;
  slug: string;
  /** Used in the "how it works" strip. */
  pickupPlace: string;
  hasCustomWork: boolean;
  bookVerb: string;
}

/** The shelf: filters, the grid, and how an order actually goes. */
export function storefrontSection(shop: StorefrontContent, palette: Palette): SafeHtml {
  if (shop.products.length === 0) return html``;

  const categories: string[] = [];
  for (const product of shop.products) {
    if (product.category && !categories.includes(product.category)) categories.push(product.category);
  }

  // "Hnota, hlynur og epoxý" and "Hlynur og eik" both mention maple; the strip
  // should say it once, in one casing.
  const materials: string[] = [];
  for (const raw of shop.products.flatMap((product) => product.material.split(/\s*(?:og|,|·)\s*/i))) {
    const word = raw.trim();
    if (word.length <= 2) continue;
    const titled = word[0]!.toLocaleUpperCase('is-IS') + word.slice(1).toLocaleLowerCase('is-IS');
    if (!materials.includes(titled)) materials.push(titled);
  }

  const shippingLine = shop.settings.allowShipping
    ? shop.settings.freeShippingOverIsk > 0
      ? `Sending kostar ${formatISK(shop.settings.shippingIsk)} og er frí yfir ${formatISK(shop.settings.freeShippingOverIsk)}`
      : `Sending kostar ${formatISK(shop.settings.shippingIsk)}`
    : 'Vörur eru sóttar á verkstæðið';

  const steps: Array<{ title: string; text: string }> = [
    { title: 'Þú pantar', text: 'Veldu vöru, settu í körfu og skildu eftir samskiptaupplýsingar. Ekkert kort, engin skuldfærsla.' },
    { title: 'Við smíðum', text: 'Við staðfestum pöntunina, sendum greiðsluupplýsingar og byrjum. Þú færð að vita þegar varan er tilbúin.' },
    {
      title: shop.settings.allowShipping ? 'Sótt eða sent' : 'Sótt á verkstæðinu',
      text: shop.settings.allowShipping
        ? `${shippingLine}. Við pökkum þannig að hlutirnir komist heilir alla leið.`
        : `${shop.pickupPlace || 'Á verkstæðinu'} — við látum vita þegar hægt er að sækja.`.trim(),
    },
  ];

  return html`
    <section class="section shop" id="verslun"
             data-api="${shop.apiBase}" data-slug="${shop.slug}">
      <div class="wrap">
        <div class="section-title reveal">
          <p class="eyebrow">Verslun</p>
          <h2>Handsmíðað, eitt stykki í einu</h2>
          <p>Hver vara er unnin af alúð og því eru engin tvö eintök alveg eins.
             ${shop.settings.allowPickup && shop.settings.allowShipping
               ? 'Sæktu á verkstæðið eða fáðu sent heim.'
               : shop.settings.allowShipping ? 'Sent hvert á land sem er.' : 'Sótt á verkstæðið.'}</p>
        </div>

        ${materials.length > 2
          ? html`<div class="grain-marquee" aria-hidden="true">
              <div class="grain-track">
                ${[0, 1].map(() => html`<span>${materials.map((word) => html`<b>${word}</b><i>·</i>`)}</span>`)}
              </div>
            </div>`
          : ''}

        ${categories.length > 1
          ? html`<div class="shop-filters reveal" role="group" aria-label="Sía eftir flokki">
              <button type="button" class="chip is-active" data-sia="*">Allt</button>
              ${categories.map((category) => html`<button type="button" class="chip" data-sia="${category}">${category}</button>`)}
            </div>`
          : ''}

        <!-- Each card reveals on its own rather than the grid revealing as a
             block: on a phone the grid is taller than the screen, so a
             container-level threshold would never be met and the shelf would
             stay blank until you scrolled past it. -->
        <div class="shop-grid">
          ${shop.products.map((product) => productCard(product, palette))}
        </div>

        <div class="shop-steps reveal-stagger">
          ${steps.map((step, index) => html`
            <div class="step">
              <span class="step-num">${index + 1}</span>
              <h3>${step.title}</h3>
              <p>${step.text}</p>
            </div>`)}
        </div>

        ${shop.hasCustomWork
          ? html`
            <div class="custom-call reveal">
              <div>
                <p class="eyebrow">Séróskir</p>
                <h3>Ertu með hugmynd sem er ekki á listanum?</h3>
                <p>Við tökum að okkur sérsmíði þegar það er mögulegt — segðu okkur frá stærð,
                   viðartegund og hvar hluturinn á að standa, og við gerum verðmat.</p>
              </div>
              <a class="btn btn-primary" href="#bokun">${shop.bookVerb}</a>
            </div>`
          : ''}
      </div>
    </section>`;
}

/** The floating basket button and the drawer it opens. Filled in by script. */
export function cartMarkup(): SafeHtml {
  return html`
    <button type="button" class="cart-fab" id="rth-korfu-takki" aria-expanded="false" aria-controls="rth-karfa" hidden>
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8">
        <path d="M4 7h16l-1.3 11.2a2 2 0 0 1-2 1.8H7.3a2 2 0 0 1-2-1.8Z" stroke-linejoin="round"/>
        <path d="M9 7V5.5a3 3 0 0 1 6 0V7" stroke-linecap="round"/>
      </svg>
      <span class="cart-label">Karfa</span>
      <span class="cart-count" data-fjoldi>0</span>
    </button>

    <div class="cart-scrim" id="rth-korfu-skuggi" hidden></div>
    <aside class="cart" id="rth-karfa" aria-label="Karfa" aria-hidden="true" hidden></aside>`;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

/**
 * Storefront styles.
 *
 * Emitted after the variant and the shared motion sheet so the shop can rely on
 * winning, and written against the palette variables so it still looks right on
 * the three light designs — the shop is not tied to the dark one.
 */
export function storefrontStyles(): string {
  return `
/* --- Shelf ------------------------------------------------------------- */
.shop-grid{display:grid;gap:clamp(1rem,2.4vw,1.6rem);
  grid-template-columns:repeat(auto-fill,minmax(min(100%,290px),1fr));margin-top:2rem}

.ware{position:relative;display:flex;flex-direction:column;overflow:hidden;
  border:1px solid var(--border);border-radius:calc(var(--corner) + 6px);
  background:var(--surface-alt);
  transform:perspective(900px) rotateX(var(--rx,0deg)) rotateY(var(--ry,0deg));
  transform-style:preserve-3d;
  transition:transform .5s cubic-bezier(.22,1,.36,1),border-color .3s ease,box-shadow .4s ease}
.ware.is-tilting{transition:transform .08s linear,border-color .3s ease,box-shadow .4s ease}
/* The shared scroll-reveal sheet resets the transform of a revealed element,
   with a selector more specific than .ware — which would flatten the tilt for
   good. The card therefore restates its own transform at a weight that wins,
   and takes its entrance from a keyframe animation instead: an animation hands
   the property back when it finishes, a declaration never does. */
.js-reveal .shop-grid .ware.reveal,
.js-reveal .shop-grid .ware.reveal.is-in{
  transform:perspective(900px) rotateX(var(--rx,0deg)) rotateY(var(--ry,0deg))}
/* A light that follows the pointer across the card. The coordinates come from
   the script as percentages; with no script the gradient simply sits centred. */
.ware::before{content:'';position:absolute;inset:0;z-index:2;pointer-events:none;opacity:0;
  transition:opacity .35s ease;border-radius:inherit;
  background:radial-gradient(22rem 22rem at var(--mx,50%) var(--my,0%),
    color-mix(in srgb,var(--brand) 22%,transparent),transparent 60%)}
.ware:hover::before,.ware:focus-within::before{opacity:1}
.ware:hover,.ware:focus-within{border-color:color-mix(in srgb,var(--brand) 55%,var(--border));
  box-shadow:0 30px 60px -34px rgba(0,0,0,.85),0 0 0 1px color-mix(in srgb,var(--brand) 18%,transparent)}
.ware.is-hidden{display:none}
.ware.is-sold-out .ware-visual{filter:grayscale(.65) brightness(.75)}

.ware-visual{position:relative;aspect-ratio:4/3;overflow:hidden;background:var(--surface);
  border-bottom:1px solid var(--border)}
.ware-visual img,.ware-art{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
.ware:hover .ware-visual img{transform:scale(1.05)}
.ware-visual img{transition:transform .8s cubic-bezier(.22,1,.36,1)}

.ware-badge{position:absolute;left:.85rem;top:.85rem;z-index:3;
  padding:.35rem .7rem;border-radius:999px;font-size:.74rem;font-weight:700;letter-spacing:.02em;
  background:color-mix(in srgb,var(--surface) 78%,transparent);color:var(--ink);
  border:1px solid var(--border);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}
.ware-badge-til{color:var(--brand-light);border-color:color-mix(in srgb,var(--brand) 45%,var(--border))}
.ware-badge-uppselt{opacity:.85}

.ware-body{display:flex;flex-direction:column;gap:.55rem;padding:1.15rem 1.25rem 1.25rem;flex:1}
.ware-body h3{margin:0;font-size:1.18rem}
.ware-tagline{margin:0;color:var(--brand-light);font-size:.88rem;font-weight:600;letter-spacing:.01em}
.ware-desc{margin:0;color:var(--muted);font-size:.92rem;line-height:1.6}
.ware-spec{display:flex;flex-wrap:wrap;gap:.4rem;margin:.15rem 0 0}
.ware-spec div{display:flex;gap:.35rem;align-items:baseline;padding:.28rem .65rem;border-radius:999px;
  background:color-mix(in srgb,var(--brand) 8%,transparent);border:1px solid var(--border);font-size:.78rem}
.ware-spec dt{color:var(--muted);margin:0}
.ware-spec dd{margin:0;font-weight:650}
.ware-foot{display:flex;align-items:center;justify-content:space-between;gap:.75rem;
  margin-top:auto;padding-top:.9rem}
.ware-price{font-size:1.22rem;font-weight:800;letter-spacing:-.02em}
.ware-gone{font-size:.9rem;color:var(--muted);font-weight:600}
.ware-add{flex:none}

/* --- Filters and marquee ----------------------------------------------- */
.shop-filters{display:flex;flex-wrap:wrap;gap:.5rem;justify-content:center;margin-top:1.75rem}
.chip{padding:.5rem 1.1rem;border-radius:999px;border:1px solid var(--border);background:transparent;
  color:var(--muted);font:inherit;font-size:.9rem;font-weight:600;cursor:pointer;
  transition:color .25s ease,border-color .25s ease,background .25s ease,transform .25s ease}
.chip:hover{color:var(--ink);border-color:color-mix(in srgb,var(--brand) 50%,var(--border))}
.chip.is-active{color:var(--on-brand);background:var(--brand);border-color:var(--brand);
  box-shadow:0 8px 24px -12px color-mix(in srgb,var(--brand) 90%,transparent)}

.grain-marquee{margin-top:1.5rem;overflow:hidden;
  -webkit-mask-image:linear-gradient(90deg,transparent,#000 12%,#000 88%,transparent);
  mask-image:linear-gradient(90deg,transparent,#000 12%,#000 88%,transparent)}
.grain-track{display:flex;width:max-content}
.grain-track span{display:flex;align-items:center;gap:1.1rem;padding-right:1.1rem;
  font-size:.82rem;letter-spacing:.28em;text-transform:uppercase;color:var(--muted);white-space:nowrap}
.grain-track b{font-weight:600}
.grain-track i{font-style:normal;color:var(--brand)}

/* --- How it works ------------------------------------------------------ */
.shop-steps{display:grid;gap:1rem;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));margin-top:2.5rem}
.step{position:relative;padding:1.4rem 1.4rem 1.4rem 1.5rem;border:1px solid var(--border);
  border-radius:var(--corner);background:var(--surface-alt);overflow:hidden}
.step::after{content:'';position:absolute;left:0;top:0;bottom:0;width:2px;
  background:linear-gradient(180deg,var(--brand),transparent);opacity:.7}
.step-num{display:grid;place-items:center;width:2rem;height:2rem;border-radius:50%;
  border:1px solid color-mix(in srgb,var(--brand) 50%,var(--border));color:var(--brand-light);
  font-weight:800;font-size:.9rem;margin-bottom:.7rem}
.step h3{margin:0 0 .3rem;font-size:1.05rem}
.step p{margin:0;color:var(--muted);font-size:.9rem;line-height:1.6}

.custom-call{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:1.5rem;
  margin-top:2.5rem;padding:clamp(1.5rem,4vw,2.5rem);border-radius:calc(var(--corner) + 6px);
  border:1px dashed color-mix(in srgb,var(--brand) 45%,var(--border));
  background:color-mix(in srgb,var(--brand) 7%,transparent)}
.custom-call h3{margin:.2rem 0 .5rem;font-size:clamp(1.2rem,2.6vw,1.6rem)}
.custom-call p{margin:0;color:var(--muted);max-width:44rem}

/* --- Basket button ------------------------------------------------------ */
.cart-fab{position:fixed;right:max(1rem,env(safe-area-inset-right));bottom:max(1rem,env(safe-area-inset-bottom));
  z-index:60;display:flex;align-items:center;gap:.55rem;padding:.8rem 1.15rem;border-radius:999px;
  border:1px solid color-mix(in srgb,var(--brand) 40%,var(--border));cursor:pointer;
  background:color-mix(in srgb,var(--surface) 82%,transparent);color:var(--ink);font:inherit;font-weight:650;
  -webkit-backdrop-filter:saturate(1.4) blur(14px);backdrop-filter:saturate(1.4) blur(14px);
  box-shadow:0 18px 40px -20px rgba(0,0,0,.8)}
.cart-fab svg{width:1.2rem;height:1.2rem;flex:none}
.cart-fab:hover{border-color:var(--brand)}
.cart-count{display:grid;place-items:center;min-width:1.5rem;height:1.5rem;padding:0 .4rem;border-radius:999px;
  background:var(--brand);color:var(--on-brand);font-size:.82rem;font-weight:800}
/* An empty basket needs the button, not the zero. */
.cart-count[hidden]{display:none}
.cart-fab[hidden]{display:none}

/* --- Drawer ------------------------------------------------------------- */
.cart-scrim{position:fixed;inset:0;z-index:70;background:rgba(3,8,5,.6);opacity:0;
  -webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px)}
.cart-scrim.is-open{opacity:1}
.cart-scrim[hidden]{display:none}

.cart{position:fixed;top:0;right:0;bottom:0;z-index:80;width:min(26rem,100%);display:flex;flex-direction:column;
  background:var(--surface);border-left:1px solid var(--border);
  box-shadow:-30px 0 80px -40px rgba(0,0,0,.9);translate:100% 0}
.cart.is-open{translate:0 0}
.cart[hidden]{display:none}
.cart-head{display:flex;align-items:center;justify-content:space-between;gap:1rem;
  padding:1.1rem 1.25rem;border-bottom:1px solid var(--border)}
.cart-head h2{margin:0;font-size:1.15rem}
.cart-close{width:2.2rem;height:2.2rem;border-radius:50%;border:1px solid var(--border);background:transparent;
  color:inherit;font:inherit;font-size:1.1rem;line-height:1;cursor:pointer}
.cart-close:hover{border-color:var(--brand);color:var(--brand-light)}
.cart-body{flex:1;overflow-y:auto;padding:1.25rem;display:flex;flex-direction:column;gap:1rem}
.cart-foot{border-top:1px solid var(--border);padding:1.1rem 1.25rem;display:grid;gap:.75rem;
  background:var(--surface-alt)}

.cart-line{display:grid;grid-template-columns:3.6rem 1fr auto;gap:.85rem;align-items:center;
  padding-bottom:1rem;border-bottom:1px solid var(--border)}
.cart-line:last-of-type{border-bottom:0;padding-bottom:0}
/* Positioned, because the artwork cloned out of a card is absolutely placed —
   without a containing block it would size itself against the drawer. */
.cart-thumb{position:relative;width:3.6rem;height:3.6rem;border-radius:12px;overflow:hidden;
  border:1px solid var(--border);background:var(--surface-alt)}
.cart-thumb img,.cart-thumb svg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
.cart-line-name{display:block;font-weight:650;font-size:.95rem;line-height:1.35}
.cart-line-price{display:block;color:var(--muted);font-size:.85rem;margin-top:.15rem}
.cart-qty{display:flex;align-items:center;gap:.15rem;border:1px solid var(--border);border-radius:999px;padding:.15rem}
.cart-qty button{width:1.7rem;height:1.7rem;border-radius:50%;border:0;background:transparent;color:inherit;
  font:inherit;font-weight:700;cursor:pointer;line-height:1}
.cart-qty button:hover{background:color-mix(in srgb,var(--brand) 25%,transparent)}
.cart-qty span{min-width:1.3rem;text-align:center;font-variant-numeric:tabular-nums;font-weight:700;font-size:.9rem}

.cart-sum{display:flex;justify-content:space-between;gap:1rem;font-size:.92rem;color:var(--muted)}
.cart-sum.is-total{color:var(--ink);font-size:1.1rem;font-weight:800}
.cart-empty{text-align:center;color:var(--muted);padding:2.5rem 1rem}
.cart-empty svg{width:3rem;height:3rem;opacity:.35;margin-bottom:.75rem}
.cart-note{font-size:.82rem;color:var(--muted);line-height:1.55;margin:0}

.cart-field{display:grid;gap:.35rem}
.cart-field label{font-weight:650;font-size:.9rem}
.cart-field input,.cart-field textarea{width:100%;padding:.7rem .85rem;border-radius:12px;font:inherit;
  color:inherit;background:var(--surface-alt);border:1px solid var(--border)}
.cart-field input:focus,.cart-field textarea:focus{outline:2px solid var(--brand);outline-offset:1px;
  border-color:var(--brand)}
.cart-choice{display:grid;grid-template-columns:1fr 1fr;gap:.5rem}
.cart-choice button{padding:.7rem .5rem;border-radius:12px;border:1px solid var(--border);background:transparent;
  color:inherit;font:inherit;font-size:.88rem;font-weight:650;cursor:pointer;display:grid;gap:.15rem}
.cart-choice button small{font-weight:500;color:var(--muted);font-size:.76rem}
.cart-choice button.is-selected{border-color:var(--brand);
  background:color-mix(in srgb,var(--brand) 15%,transparent)}
.cart-error{padding:.75rem .9rem;border-radius:12px;font-size:.88rem;
  background:color-mix(in srgb,#dc2626 16%,transparent);border:1px solid color-mix(in srgb,#dc2626 45%,transparent)}
.cart-done{text-align:center;padding:1.5rem 0}
.cart-done .cart-ref{display:inline-block;margin:.5rem 0 1rem;padding:.5rem 1.1rem;border-radius:999px;
  border:1px dashed color-mix(in srgb,var(--brand) 55%,var(--border));font-weight:800;letter-spacing:.06em}
.cart-seal{width:3.5rem;height:3.5rem;margin:0 auto .5rem;border-radius:50%;display:grid;place-items:center;
  background:var(--brand);color:var(--on-brand);font-size:1.6rem;font-weight:700}

/* The chip that flies from the shelf to the basket. */
.fly-chip{position:fixed;z-index:90;pointer-events:none;border-radius:12px;overflow:hidden;
  box-shadow:0 12px 30px -12px rgba(0,0,0,.8);border:1px solid var(--brand)}

@media (max-width:720px){
  /* The sticky call-to-action bar owns the bottom of a phone screen, so the
     basket sits above it rather than on top of it. */
  .cart-fab{bottom:calc(4.6rem + env(safe-area-inset-bottom))}
}

@media (max-width:640px){
  .ware-foot{flex-wrap:wrap}
  .cart-fab .cart-label{display:none}
  .custom-call .btn{width:100%;text-align:center}
}

/* ========================================================================
   Motion. Everything above stands still on its own; this is the layer a
   visitor who asked for less movement never receives.
   ======================================================================== */
@media (prefers-reduced-motion: no-preference){
  .cart{transition:translate .45s cubic-bezier(.22,1,.36,1)}
  .cart-scrim{transition:opacity .35s ease}
  .cart-fab{transition:transform .3s cubic-bezier(.34,1.4,.64,1),border-color .25s ease,box-shadow .3s ease}
  .cart-fab:hover{transform:translateY(-2px)}
  .cart-fab.is-bumped{animation:cart-bump .55s cubic-bezier(.34,1.6,.64,1)}
  @keyframes cart-bump{
    0%{transform:scale(1)}
    35%{transform:scale(1.14) translateY(-4px)}
    100%{transform:scale(1)}
  }
  .cart-count{transition:transform .3s cubic-bezier(.34,1.6,.64,1)}
  .cart-fab.is-bumped .cart-count{transform:scale(1.35)}

  .cart-line{animation:line-in .45s cubic-bezier(.22,1,.36,1) both}
  @keyframes line-in{from{opacity:0;transform:translateX(14px)}to{opacity:1;transform:none}}

  /* The resin river in the generated artwork is poured rather than drawn. */
  .ware-sheen{stroke-dasharray:900;stroke-dashoffset:900;animation:pour 2.4s cubic-bezier(.22,1,.36,1) forwards}
  @keyframes pour{to{stroke-dashoffset:0}}
  .ware:hover .ware-river{filter:drop-shadow(0 0 8px color-mix(in srgb,var(--brand) 70%,transparent))}
  .ware-river{transition:filter .45s ease}

  .grain-track{animation:grain-scroll 38s linear infinite}
  @keyframes grain-scroll{from{transform:translateX(0)}to{transform:translateX(-50%)}}
  .grain-marquee:hover .grain-track{animation-play-state:paused}

  .chip{transition:color .25s ease,border-color .25s ease,background .25s ease,transform .25s ease}
  .chip:active{transform:scale(.96)}
  .ware.is-filtering,
  .js-reveal .shop-grid .ware.reveal.is-in{animation:ware-settle .55s cubic-bezier(.22,1,.36,1)}
  @keyframes ware-settle{from{opacity:0;transform:translateY(16px) scale(.97)}to{opacity:1;transform:none}}

  .step{transition:transform .4s cubic-bezier(.22,1,.36,1),border-color .3s ease}
  .step:hover{transform:translateY(-4px);border-color:color-mix(in srgb,var(--brand) 45%,var(--border))}
  .step::after{transform-origin:top;animation:step-grow 1.1s cubic-bezier(.22,1,.36,1) both}
  @keyframes step-grow{from{transform:scaleY(0)}to{transform:scaleY(1)}}
}

@media (prefers-reduced-motion: reduce){
  .ware,.ware-visual img{transform:none !important}
}
`;
}

// ---------------------------------------------------------------------------
// Script
// ---------------------------------------------------------------------------

/**
 * The basket.
 *
 * Written in the same plain style as the booking widget: no build step, no
 * dependencies, `var` and functions so it parses on anything. State is the
 * visitor's own — a map of product id to quantity in `localStorage` — and the
 * server prices it from scratch on submit.
 */
export function storefrontScript(): string {
  return String.raw`
(function () {
  'use strict';

  var shop = document.querySelector('.shop[data-api]');
  var fab = document.getElementById('rth-korfu-takki');
  var drawer = document.getElementById('rth-karfa');
  var scrim = document.getElementById('rth-korfu-skuggi');
  if (!shop || !fab || !drawer || !scrim) return;

  var api = shop.getAttribute('data-api');
  var slug = shop.getAttribute('data-slug');
  var storageKey = 'rth-karfa:' + slug;
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var fine = !window.matchMedia || window.matchMedia('(pointer: fine)').matches;

  var state = {
    lines: {},          // productId -> quantity
    config: null,       // catalogue and shop policy, fetched on first open
    step: 'karfa',      // karfa -> skil -> lokid
    delivery: null,
    offline: false,   // catalogue unreachable; the shelf still prices the basket
    form: {},
    submitting: false,
    order: null,
    error: '',
    fieldErrors: {}
  };

  // -- helpers --------------------------------------------------------------

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (key) {
      if (key === 'class') node.className = attrs[key];
      else if (key === 'text') node.textContent = attrs[key];
      else if (key === 'html') node.innerHTML = attrs[key];
      else if (key.indexOf('on') === 0) node.addEventListener(key.slice(2), attrs[key]);
      else if (attrs[key] !== null && attrs[key] !== undefined) node.setAttribute(key, attrs[key]);
    });
    (children || []).forEach(function (child) {
      if (child) node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }

  function formatIsk(amount) {
    return String(Math.round(amount)).replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ' kr.';
  }

  function readStored() {
    try {
      var raw = localStorage.getItem(storageKey);
      var parsed = raw ? JSON.parse(raw) : {};
      Object.keys(parsed).forEach(function (key) {
        var quantity = Math.round(Number(parsed[key]));
        if (quantity > 0 && quantity <= 20) state.lines[key] = quantity;
      });
    } catch (error) { /* private mode, or someone edited it by hand */ }
  }

  function persist() {
    try { localStorage.setItem(storageKey, JSON.stringify(state.lines)); } catch (error) { /* ignore */ }
  }

  function count() {
    return Object.keys(state.lines).reduce(function (sum, key) { return sum + state.lines[key]; }, 0);
  }

  /**
   * What a line costs. Prices come from the fetched catalogue when it is
   * loaded, and from the markup before that, so the basket shows real numbers
   * from the very first click.
   */
  function productFor(productId) {
    if (state.config) {
      var match = state.config.vorur.filter(function (item) { return item.id === productId; })[0];
      if (match) return match;
    }
    var card = shop.querySelector('.ware[data-vara="' + productId + '"]');
    if (!card) return null;
    return {
      id: productId,
      heiti: card.getAttribute('data-heiti'),
      verd: Number(card.getAttribute('data-verd')) || 0,
      hamark: 20,
      mynd: ''
    };
  }

  function subtotal() {
    return Object.keys(state.lines).reduce(function (sum, key) {
      var product = productFor(key);
      return sum + (product ? product.verd * state.lines[key] : 0);
    }, 0);
  }

  function settings() {
    return (state.config && state.config.stillingar) || {
      sending: 0, fritYfir: 0, maSaekja: true, maSenda: false, greidsla: '', afhending: ''
    };
  }

  function shippingCost() {
    var s = settings();
    if (state.delivery !== 'sending') return 0;
    if (s.fritYfir > 0 && subtotal() >= s.fritYfir) return 0;
    return s.sending;
  }

  function request(path, body) {
    return fetch(api + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (response) {
      return response.json().then(function (data) {
        if (!response.ok) {
          var error = new Error(data && data.skilabod ? data.skilabod : 'Eitthvað fór úrskeiðis.');
          error.villur = (data && data.villur) || {};
          throw error;
        }
        return data;
      });
    });
  }

  // -- catalogue ------------------------------------------------------------

  var loading = null;
  function loadConfig() {
    if (state.config) return Promise.resolve(state.config);
    if (loading) return loading;

    loading = request('/verslun?slug=' + encodeURIComponent(slug))
      .then(function (data) {
        state.config = data;
        state.offline = false;
        if (!state.delivery) state.delivery = data.stillingar.maSaekja ? 'saekja' : 'sending';
        // Something sold out, or was taken off the shelf, while the basket sat
        // in this browser. Drop it rather than fail at checkout.
        var removed = 0;
        Object.keys(state.lines).forEach(function (key) {
          var match = data.vorur.filter(function (item) { return item.id === key; })[0];
          if (!match) { delete state.lines[key]; removed++; return; }
          if (state.lines[key] > match.hamark) state.lines[key] = match.hamark;
          if (state.lines[key] < 1) { delete state.lines[key]; removed++; }
        });
        if (removed > 0) {
          state.error = removed === 1
            ? 'Ein vara í körfunni er ekki lengur fáanleg og var fjarlægð.'
            : removed + ' vörur í körfunni eru ekki lengur fáanlegar og voru fjarlægðar.';
          persist();
        }
        return data;
      })
      .catch(function () {
        loading = null;
        // Not an error the shopper needs to see yet. The basket prices itself
        // from the shelf that is already on the page, so browsing and adding
        // still work; only the checkout genuinely needs the catalogue, and it
        // raises this itself when the submit fails.
        state.offline = true;
        return null;
      });

    return loading;
  }

  // -- basket ---------------------------------------------------------------

  function setQuantity(productId, quantity) {
    var product = productFor(productId);
    var max = product && product.hamark ? product.hamark : 20;
    if (quantity <= 0) delete state.lines[productId];
    else state.lines[productId] = Math.min(quantity, max);
    persist();
    syncFab();
    render();
  }

  function addToCart(productId, sourceNode) {
    var current = state.lines[productId] || 0;
    setQuantity(productId, current + 1);
    bumpFab();
    if (sourceNode) flyToCart(sourceNode);
  }

  function syncFab() {
    var total = count();
    fab.hidden = false;
    var badge = fab.querySelector('[data-fjoldi]');
    if (badge) {
      badge.textContent = String(total);
      badge.hidden = total === 0;
    }
    fab.setAttribute('aria-label',
      total === 0 ? 'Karfa — tóm' : total === 1 ? 'Karfa — ein vara' : 'Karfa — ' + total + ' vörur');
  }

  function bumpFab() {
    if (reduced) return;
    fab.classList.remove('is-bumped');
    // Restart the animation: reading offsetWidth forces the class removal to
    // take effect before it goes back on.
    void fab.offsetWidth;
    fab.classList.add('is-bumped');
  }

  /**
   * Sends a copy of the product's artwork on an arc into the basket button.
   * Purely decorative — it tells you *where* the thing you clicked went, which
   * a number quietly changing in the corner does not.
   */
  function flyToCart(card) {
    if (reduced || !card.animate) return;
    var visual = card.querySelector('.ware-visual');
    if (!visual) return;

    var from = visual.getBoundingClientRect();
    var to = fab.getBoundingClientRect();
    var chip = visual.cloneNode(true);
    chip.className = 'fly-chip';
    chip.style.left = from.left + 'px';
    chip.style.top = from.top + 'px';
    chip.style.width = from.width + 'px';
    chip.style.height = from.height + 'px';
    document.body.appendChild(chip);

    var dx = (to.left + to.width / 2) - (from.left + from.width / 2);
    var dy = (to.top + to.height / 2) - (from.top + from.height / 2);

    var animation = chip.animate([
      { transform: 'translate(0,0) scale(1)', opacity: 0.95 },
      { transform: 'translate(' + dx * 0.55 + 'px,' + (dy * 0.35 - 60) + 'px) scale(.5)', opacity: 0.85, offset: 0.55 },
      { transform: 'translate(' + dx + 'px,' + dy + 'px) scale(.08)', opacity: 0 }
    ], { duration: 720, easing: 'cubic-bezier(.4,0,.2,1)' });

    animation.onfinish = function () { chip.remove(); };
  }

  // -- drawer ---------------------------------------------------------------

  var lastFocused = null;

  function openCart() {
    lastFocused = document.activeElement;
    drawer.hidden = false;
    scrim.hidden = false;
    // A frame between "in the DOM" and "open" is what gives the transition
    // something to animate from.
    requestAnimationFrame(function () {
      drawer.classList.add('is-open');
      scrim.classList.add('is-open');
    });
    drawer.setAttribute('aria-hidden', 'false');
    fab.setAttribute('aria-expanded', 'true');
    document.body.style.overflow = 'hidden';

    loadConfig().then(function () { render(); focusFirst(); });
    render();
    focusFirst();
  }

  function focusFirst() {
    var target = drawer.querySelector('.cart-close');
    if (target) target.focus();
  }

  function closeCart() {
    drawer.classList.remove('is-open');
    scrim.classList.remove('is-open');
    drawer.setAttribute('aria-hidden', 'true');
    fab.setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';

    var hide = function () { drawer.hidden = true; scrim.hidden = true; };
    if (reduced) hide(); else setTimeout(hide, 450);
    if (lastFocused && lastFocused.focus) lastFocused.focus();
  }

  fab.addEventListener('click', openCart);
  scrim.addEventListener('click', closeCart);
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !drawer.hidden) closeCart();
  });

  // -- drawer contents ------------------------------------------------------

  function lineRow(productId) {
    var product = productFor(productId);
    if (!product) return null;
    var quantity = state.lines[productId];

    var thumb = el('div', { class: 'cart-thumb' });
    var card = shop.querySelector('.ware[data-vara="' + productId + '"] .ware-visual');
    if (product.mynd) {
      thumb.appendChild(el('img', { src: product.mynd, alt: '', loading: 'lazy' }));
    } else if (card) {
      var art = card.querySelector('.ware-art, img');
      if (art) thumb.appendChild(art.cloneNode(true));
    }

    return el('div', { class: 'cart-line' }, [
      thumb,
      el('div', {}, [
        el('strong', { class: 'cart-line-name', text: product.heiti }),
        el('span', { class: 'cart-line-price', text: formatIsk(product.verd) + (quantity > 1 ? ' × ' + quantity : '') })
      ]),
      el('div', { class: 'cart-qty' }, [
        el('button', {
          type: 'button', text: '−', 'aria-label': 'Fækka',
          onclick: function () { setQuantity(productId, quantity - 1); }
        }),
        el('span', { text: String(quantity) }),
        el('button', {
          type: 'button', text: '+', 'aria-label': 'Fjölga',
          onclick: function () { setQuantity(productId, quantity + 1); }
        })
      ])
    ]);
  }

  function emptyView() {
    return el('div', { class: 'cart-empty' }, [
      el('p', { text: 'Karfan er tóm.' }),
      el('p', { class: 'cart-note', text: 'Veldu vöru úr verslunni — við smíðum og þú sækir eða færð sent.' })
    ]);
  }

  function summaryRows() {
    var rows = [
      el('div', { class: 'cart-sum' }, [el('span', { text: 'Vörur' }), el('span', { text: formatIsk(subtotal()) })])
    ];
    if (state.step !== 'karfa' && state.delivery === 'sending') {
      var shipping = shippingCost();
      rows.push(el('div', { class: 'cart-sum' }, [
        el('span', { text: 'Sending' }),
        el('span', { text: shipping === 0 ? 'Frí' : formatIsk(shipping) })
      ]));
    }
    rows.push(el('div', { class: 'cart-sum is-total' }, [
      el('span', { text: 'Samtals' }),
      el('span', { text: formatIsk(subtotal() + shippingCost()) })
    ]));
    return rows;
  }

  function field(key, label, attrs) {
    var input = el(attrs && attrs.multiline ? 'textarea' : 'input', {
      id: 'rth-' + key,
      name: key,
      type: (attrs && attrs.type) || 'text',
      rows: attrs && attrs.multiline ? '3' : null,
      autocomplete: attrs && attrs.autocomplete,
      placeholder: (attrs && attrs.placeholder) || '',
      value: (state.form && state.form[key]) || ''
    });
    if (attrs && attrs.multiline) input.value = (state.form && state.form[key]) || '';
    input.addEventListener('input', function () {
      state.form = state.form || {};
      state.form[key] = input.value;
    });

    return el('div', { class: 'cart-field' }, [
      el('label', { for: 'rth-' + key, text: label }),
      input,
      state.fieldErrors[key] ? el('p', { class: 'cart-note', style: 'color:#fca5a5', text: state.fieldErrors[key] }) : null
    ]);
  }

  function deliveryChoice() {
    var s = settings();
    var options = [];
    if (s.maSaekja) options.push({ value: 'saekja', label: 'Sækja', hint: s.afhending || 'Á verkstæðinu' });
    if (s.maSenda) {
      options.push({
        value: 'sending',
        label: 'Senda heim',
        hint: s.fritYfir > 0 && subtotal() >= s.fritYfir ? 'Frí sending' : formatIsk(s.sending)
      });
    }
    if (options.length < 2) return null;

    return el('div', { class: 'cart-field' }, [
      el('label', { text: 'Afhending' }),
      el('div', { class: 'cart-choice' }, options.map(function (option) {
        return el('button', {
          type: 'button',
          class: state.delivery === option.value ? 'is-selected' : '',
          onclick: function () { state.delivery = option.value; render(); }
        }, [document.createTextNode(option.label), el('small', { text: option.hint })]);
      }))
    ]);
  }

  function checkoutView() {
    var s = settings();
    var nodes = [
      el('button', {
        type: 'button', class: 'chip', text: '← Til baka í körfu',
        onclick: function () { state.step = 'karfa'; render(); }
      }),
      field('nafn', 'Nafn', { autocomplete: 'name' }),
      field('simi', 'Símanúmer', { type: 'tel', autocomplete: 'tel', placeholder: '555 1234' }),
      field('netfang', 'Netfang', { type: 'email', autocomplete: 'email' })
    ];

    var choice = deliveryChoice();
    if (choice) nodes.push(choice);

    if (state.delivery === 'sending') {
      nodes.push(field('heimilisfang', 'Heimilisfang', { autocomplete: 'street-address' }));
      nodes.push(field('postnumer', 'Póstnúmer', { autocomplete: 'postal-code', placeholder: '740' }));
      nodes.push(field('stadur', 'Staður', { autocomplete: 'address-level2' }));
    }

    nodes.push(field('athugasemd', 'Athugasemd', { multiline: true, placeholder: 'Séróskir, áletrun, tímasetning…' }));
    if (s.greidsla) nodes.push(el('p', { class: 'cart-note', text: s.greidsla }));
    return nodes;
  }

  function doneView() {
    var order = state.order || {};
    return [
      el('div', { class: 'cart-done' }, [
        el('div', { class: 'cart-seal', text: '✓' }),
        el('h3', { text: 'Takk fyrir pöntunina' }),
        el('span', { class: 'cart-ref', text: order.pontun || '' }),
        el('p', { class: 'cart-note', text: order.skilabod || 'Við höfum samband og staðfestum.' })
      ]),
      el('button', {
        type: 'button', class: 'btn btn-ghost', text: 'Halda áfram að skoða',
        onclick: function () { closeCart(); }
      })
    ];
  }

  function submit(button) {
    if (state.submitting) return;
    state.submitting = true;
    state.error = '';
    state.fieldErrors = {};
    button.disabled = true;
    button.textContent = 'Sendi pöntun…';

    var form = state.form || {};
    request('/pontun', {
      slug: slug,
      afhending: state.delivery,
      linur: Object.keys(state.lines).map(function (key) {
        return { vara: key, fjoldi: state.lines[key] };
      }),
      nafn: form.nafn || '',
      simi: form.simi || '',
      netfang: form.netfang || '',
      heimilisfang: form.heimilisfang || '',
      postnumer: form.postnumer || '',
      stadur: form.stadur || '',
      athugasemd: form.athugasemd || ''
    })
      .then(function (data) {
        state.order = data;
        state.step = 'lokid';
        state.lines = {};
        state.submitting = false;
        state.form = {};
        persist();
        syncFab();
        render();
      })
      .catch(function (error) {
        state.submitting = false;
        state.error = error.message;
        state.fieldErrors = error.villur || {};
        // Stock ran out while the form was open: refetch so the shelf and the
        // basket agree before they try again.
        state.config = null;
        loading = null;
        loadConfig().then(render);
        render();
      });
  }

  function render() {
    if (drawer.hidden && !drawer.classList.contains('is-open')) return;

    drawer.innerHTML = '';
    var total = count();

    drawer.appendChild(el('div', { class: 'cart-head' }, [
      el('h2', { text: state.step === 'lokid' ? 'Pöntun staðfest' : state.step === 'skil' ? 'Ganga frá pöntun' : 'Karfan þín' }),
      el('button', { type: 'button', class: 'cart-close', text: '✕', 'aria-label': 'Loka körfu', onclick: closeCart })
    ]));

    var body = el('div', { class: 'cart-body' });
    drawer.appendChild(body);

    if (state.error) body.appendChild(el('div', { class: 'cart-error', role: 'alert', text: state.error }));

    if (state.step === 'lokid') {
      doneView().forEach(function (node) { body.appendChild(node); });
      return;
    }

    if (total === 0) {
      body.appendChild(emptyView());
      return;
    }

    if (state.step === 'skil') {
      checkoutView().forEach(function (node) { body.appendChild(node); });
    } else {
      Object.keys(state.lines).forEach(function (key) {
        var row = lineRow(key);
        if (row) body.appendChild(row);
      });
    }

    var foot = el('div', { class: 'cart-foot' });
    summaryRows().forEach(function (row) { foot.appendChild(row); });

    if (state.step === 'skil') {
      var submitButton = el('button', { type: 'button', class: 'btn btn-primary', text: 'Senda pöntun' });
      submitButton.addEventListener('click', function () { submit(submitButton); });
      foot.appendChild(submitButton);
      foot.appendChild(el('p', { class: 'cart-note', text: 'Engin greiðsla fer fram á vefnum.' }));
    } else {
      foot.appendChild(el('button', {
        type: 'button', class: 'btn btn-primary', text: 'Ganga frá pöntun',
        onclick: function () {
          state.step = 'skil';
          state.error = '';
          // Checkout is where the catalogue actually matters — for the delivery
          // options, the postage and the final price. Say so here if it never
          // arrived, rather than the moment the basket was opened.
          loadConfig().then(function () {
            if (state.offline) {
              state.error = 'Ekki næst samband við verslunina í augnablikinu. Reyndu aftur eftir smástund.';
            }
            render();
          });
          render();
        }
      }));
    }

    drawer.appendChild(foot);
  }

  // -- shelf ----------------------------------------------------------------

  shop.addEventListener('click', function (event) {
    var button = event.target.closest ? event.target.closest('.ware-add') : null;
    if (!button) return;
    var card = button.closest('.ware');
    addToCart(button.getAttribute('data-vara'), card);
  });

  var filters = shop.querySelectorAll('.chip[data-sia]');
  Array.prototype.forEach.call(filters, function (chip) {
    chip.addEventListener('click', function () {
      var wanted = chip.getAttribute('data-sia');
      Array.prototype.forEach.call(filters, function (other) {
        other.classList.toggle('is-active', other === chip);
      });
      Array.prototype.forEach.call(shop.querySelectorAll('.ware'), function (card) {
        var show = wanted === '*' || card.getAttribute('data-flokkur') === wanted;
        card.classList.toggle('is-hidden', !show);
        if (show && !reduced) {
          card.classList.remove('is-filtering');
          void card.offsetWidth;
          card.classList.add('is-filtering');
        }
      });
    });
  });

  /**
   * Pointer light and tilt.
   *
   * Only on a real pointer — on a touch screen there is nothing to follow, and
   * a card that tilts under a finger just looks broken.
   */
  if (fine && !reduced) {
    Array.prototype.forEach.call(shop.querySelectorAll('.ware'), function (card) {
      card.addEventListener('pointermove', function (event) {
        var box = card.getBoundingClientRect();
        var x = (event.clientX - box.left) / box.width;
        var y = (event.clientY - box.top) / box.height;
        card.classList.add('is-tilting');
        card.style.setProperty('--mx', (x * 100).toFixed(1) + '%');
        card.style.setProperty('--my', (y * 100).toFixed(1) + '%');
        card.style.setProperty('--ry', ((x - 0.5) * 7).toFixed(2) + 'deg');
        card.style.setProperty('--rx', ((0.5 - y) * 5).toFixed(2) + 'deg');
      });
      card.addEventListener('pointerleave', function () {
        card.classList.remove('is-tilting');
        card.style.setProperty('--rx', '0deg');
        card.style.setProperty('--ry', '0deg');
      });
    });
  }

  // -- boot -----------------------------------------------------------------

  readStored();
  syncFab();
  if (count() > 0) loadConfig().then(render);
})();
`;
}
