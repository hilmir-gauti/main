/**
 * Icelandic email templates.
 *
 * Every template renders both a plain-text and an HTML part. The text part is
 * not an afterthought: it is what shows in notification previews and what a
 * customer sees if their client blocks HTML, so it has to read properly on
 * its own.
 *
 * Tone: direct and warm, the way a small Icelandic business writes — "Takk
 * fyrir að bóka hjá okkur", not "Dear valued customer".
 */

import { escapeHtml } from '../../core/html.ts';
import { formatISK } from '../../core/iceland.ts';
import { formatDateTimeIs, formatDurationIs, type Instant } from '../../core/time.ts';
import { config } from '../../config.ts';
import type { BookingView, Tenant } from '../../domain/types.ts';

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

/**
 * Shared HTML shell. Table-based and inline-styled because email clients
 * (Outlook especially) still do not support modern CSS layout.
 */
function layout(options: {
  tenant: Pick<Tenant, 'name' | 'brandColor' | 'phone' | 'email' | 'websiteDomain'>;
  heading: string;
  intro: string;
  rows?: Array<[string, string]>;
  callout?: { text: string; url: string; label: string };
  footerNote?: string;
}): string {
  const brand = /^#[0-9a-fA-F]{6}$/.test(options.tenant.brandColor) ? options.tenant.brandColor : '#1d4ed8';

  const rowsHtml = (options.rows ?? [])
    .filter(([, value]) => value)
    .map(
      ([label, value]) => `
        <tr>
          <td style="padding:8px 0;color:#64748b;font-size:14px;vertical-align:top;width:40%">${escapeHtml(label)}</td>
          <td style="padding:8px 0;color:#0f172a;font-size:15px;font-weight:600">${escapeHtml(value)}</td>
        </tr>`,
    )
    .join('');

  const buttonHtml = options.callout
    ? `<tr><td style="padding:24px 0 8px">
         <a href="${escapeHtml(options.callout.url)}"
            style="display:inline-block;background:${brand};color:#ffffff;text-decoration:none;
                   padding:12px 22px;border-radius:8px;font-weight:600;font-size:15px">
           ${escapeHtml(options.callout.label)}
         </a>
       </td></tr>
       <tr><td style="color:#64748b;font-size:13px;padding-bottom:8px">${escapeHtml(options.callout.text)}</td></tr>`
    : '';

  const contactBits = [
    options.tenant.phone ? `Sími: ${options.tenant.phone}` : '',
    options.tenant.email,
    options.tenant.websiteDomain,
  ].filter(Boolean).map(escapeHtml).join(' · ');

  return `<!doctype html>
<html lang="is"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(options.heading)}</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
             style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;
                    box-shadow:0 1px 3px rgba(15,23,42,.08)">
        <tr><td style="background:${brand};padding:20px 28px">
          <div style="color:#ffffff;font-size:17px;font-weight:700">${escapeHtml(options.tenant.name)}</div>
        </td></tr>
        <tr><td style="padding:28px">
          <h1 style="margin:0 0 12px;font-size:21px;color:#0f172a">${escapeHtml(options.heading)}</h1>
          <p style="margin:0 0 18px;color:#475569;font-size:15px;line-height:1.6">${escapeHtml(options.intro)}</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
                 style="border-top:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0;margin:8px 0">
            ${rowsHtml}
          </table>
          <table role="presentation" cellpadding="0" cellspacing="0">${buttonHtml}</table>
          ${options.footerNote ? `<p style="margin:18px 0 0;color:#64748b;font-size:13px;line-height:1.6">${escapeHtml(options.footerNote)}</p>` : ''}
        </td></tr>
        <tr><td style="padding:16px 28px;background:#f8fafc;color:#94a3b8;font-size:12px;text-align:center">
          ${contactBits}
        </td></tr>
      </table>
      <p style="color:#94a3b8;font-size:11px;margin:14px 0 0">Sent með Rafrænni Þjónustu</p>
    </td></tr>
  </table>
</body></html>`;
}

function textBlock(lines: Array<string | false | null | undefined>): string {
  return lines.filter((line): line is string => Boolean(line)).join('\n');
}

function bookingRows(booking: BookingView, durationMin: number): Array<[string, string]> {
  return [
    ['Þjónusta', booking.serviceName],
    ['Tími', formatDateTimeIs(booking.startsAt, booking.tenantTimezone, { year: true })],
    ['Lengd', formatDurationIs(durationMin)],
    ['Starfsmaður', booking.staffName ?? ''],
    ['Verð', booking.priceIsk > 0 ? formatISK(booking.priceIsk) : ''],
  ];
}

const cancelUrl = (booking: BookingView) => `${config.baseUrl}/afbokun/${booking.cancelToken}`;

// ---------------------------------------------------------------------------
// Customer-facing
// ---------------------------------------------------------------------------

export function bookingConfirmation(tenant: Tenant, booking: BookingView, durationMin: number): RenderedEmail {
  const when = formatDateTimeIs(booking.startsAt, tenant.timezone, { year: true });

  return {
    subject: `Staðfesting: ${booking.serviceName} — ${when}`,
    text: textBlock([
      `Sæl/l ${booking.customerName},`,
      '',
      `Tíminn þinn hjá ${tenant.name} er staðfestur.`,
      '',
      `Þjónusta: ${booking.serviceName}`,
      `Tími: ${when}`,
      `Lengd: ${formatDurationIs(durationMin)}`,
      booking.staffName && `Starfsmaður: ${booking.staffName}`,
      booking.priceIsk > 0 && `Verð: ${formatISK(booking.priceIsk)}`,
      tenant.address && `Staðsetning: ${tenant.address}, ${tenant.postcode} ${tenant.city}`,
      '',
      `Þarftu að breyta eða afbóka? Notaðu þennan tengil: ${cancelUrl(booking)}`,
      `Vinsamlegast láttu vita með minnst ${tenant.cancelWindowHours} klukkustunda fyrirvara.`,
      '',
      'Takk fyrir að bóka hjá okkur!',
      tenant.name,
      tenant.phone && `Sími: ${tenant.phone}`,
    ]),
    html: layout({
      tenant,
      heading: 'Tíminn þinn er staðfestur',
      intro: `Sæl/l ${booking.customerName}, við hlökkum til að sjá þig hjá ${tenant.name}.`,
      rows: [
        ...bookingRows(booking, durationMin),
        ['Staðsetning', tenant.address ? `${tenant.address}, ${tenant.postcode} ${tenant.city}` : ''],
      ],
      callout: {
        url: cancelUrl(booking),
        label: 'Breyta eða afbóka',
        text: `Vinsamlegast láttu vita með minnst ${tenant.cancelWindowHours} klst. fyrirvara.`,
      },
      footerNote: 'Takk fyrir að bóka hjá okkur!',
    }),
  };
}

export function bookingReminder(tenant: Tenant, booking: BookingView, durationMin: number): RenderedEmail {
  const when = formatDateTimeIs(booking.startsAt, tenant.timezone);

  return {
    subject: `Áminning: ${booking.serviceName} ${when}`,
    text: textBlock([
      `Sæl/l ${booking.customerName},`,
      '',
      `Þetta er áminning um tímann þinn hjá ${tenant.name} ${when}.`,
      '',
      `Þjónusta: ${booking.serviceName}`,
      booking.staffName && `Starfsmaður: ${booking.staffName}`,
      tenant.address && `Staðsetning: ${tenant.address}, ${tenant.postcode} ${tenant.city}`,
      '',
      `Kemstu ekki? Afbókaðu hér: ${cancelUrl(booking)}`,
      '',
      tenant.name,
    ]),
    html: layout({
      tenant,
      heading: 'Áminning um tímann þinn',
      intro: `Sæl/l ${booking.customerName}, við minnum á tímann þinn ${when}.`,
      rows: [
        ...bookingRows(booking, durationMin),
        ['Staðsetning', tenant.address ? `${tenant.address}, ${tenant.postcode} ${tenant.city}` : ''],
      ],
      callout: { url: cancelUrl(booking), label: 'Breyta eða afbóka', text: 'Kemstu ekki? Láttu okkur vita.' },
    }),
  };
}

export function bookingCancelled(tenant: Tenant, booking: BookingView, reason: string): RenderedEmail {
  const when = formatDateTimeIs(booking.startsAt, tenant.timezone, { year: true });

  return {
    subject: `Afbókun staðfest: ${booking.serviceName} — ${when}`,
    text: textBlock([
      `Sæl/l ${booking.customerName},`,
      '',
      `Tíminn þinn hjá ${tenant.name} ${when} hefur verið afbókaður.`,
      reason && `Ástæða: ${reason}`,
      '',
      `Viltu bóka nýjan tíma? ${tenant.websiteDomain ? `https://${tenant.websiteDomain}` : `${config.baseUrl}/b/${tenant.slug}`}`,
      '',
      tenant.name,
    ]),
    html: layout({
      tenant,
      heading: 'Afbókun staðfest',
      intro: `Tíminn þinn ${when} hefur verið afbókaður.`,
      rows: [['Þjónusta', booking.serviceName], ['Tími', when], ['Ástæða', reason]],
      callout: {
        url: tenant.websiteDomain ? `https://${tenant.websiteDomain}` : `${config.baseUrl}/b/${tenant.slug}`,
        label: 'Bóka nýjan tíma',
        text: 'Við tökum vel á móti þér næst.',
      },
    }),
  };
}

export function bookingRescheduled(tenant: Tenant, booking: BookingView, previousStartsAt: Instant, durationMin: number): RenderedEmail {
  const before = formatDateTimeIs(previousStartsAt, tenant.timezone, { year: true });
  const after = formatDateTimeIs(booking.startsAt, tenant.timezone, { year: true });

  return {
    subject: `Tímanum þínum hefur verið breytt — ${after}`,
    text: textBlock([
      `Sæl/l ${booking.customerName},`,
      '',
      `Tímanum þínum hjá ${tenant.name} hefur verið breytt.`,
      '',
      `Fyrri tími: ${before}`,
      `Nýr tími: ${after}`,
      `Þjónusta: ${booking.serviceName}`,
      '',
      `Hentar þetta ekki? Hafðu samband${tenant.phone ? ` í síma ${tenant.phone}` : ''} eða afbókaðu hér: ${cancelUrl(booking)}`,
      '',
      tenant.name,
    ]),
    html: layout({
      tenant,
      heading: 'Tímanum þínum hefur verið breytt',
      intro: 'Hér eru uppfærðar upplýsingar um tímann þinn.',
      rows: [
        ['Fyrri tími', before],
        ['Nýr tími', after],
        ...bookingRows(booking, durationMin).filter(([label]) => label !== 'Tími'),
      ],
      callout: { url: cancelUrl(booking), label: 'Breyta eða afbóka', text: 'Hentar nýi tíminn ekki?' },
    }),
  };
}

// ---------------------------------------------------------------------------
// Business-facing
// ---------------------------------------------------------------------------

export function newBookingForOwner(tenant: Tenant, booking: BookingView, durationMin: number): RenderedEmail {
  const when = formatDateTimeIs(booking.startsAt, tenant.timezone, { year: true });
  const sourceLabel = booking.source === 'simi' ? 'símsvara' : booking.source === 'vefur' ? 'vefsíðunni' : booking.source;

  return {
    subject: `Ný bókun: ${booking.customerName} — ${when}`,
    text: textBlock([
      `Ný bókun kom inn í gegnum ${sourceLabel}.`,
      '',
      `Viðskiptavinur: ${booking.customerName}`,
      booking.customerPhone && `Sími: ${booking.customerPhone}`,
      booking.customerEmail && `Netfang: ${booking.customerEmail}`,
      `Þjónusta: ${booking.serviceName}`,
      `Tími: ${when}`,
      booking.staffName && `Starfsmaður: ${booking.staffName}`,
      booking.notes && `\nAthugasemd: ${booking.notes}`,
      '',
      `Skoða í stjórnborði: ${config.baseUrl}/vidskiptavinir/${tenant.id}/bokanir`,
    ]),
    html: layout({
      tenant,
      heading: 'Ný bókun',
      intro: `Bókun barst í gegnum ${sourceLabel}.`,
      rows: [
        ['Viðskiptavinur', booking.customerName],
        ['Sími', booking.customerPhone],
        ['Netfang', booking.customerEmail],
        ...bookingRows(booking, durationMin),
        ['Athugasemd', booking.notes],
      ],
      callout: {
        url: `${config.baseUrl}/vidskiptavinir/${tenant.id}/bokanir`,
        label: 'Opna stjórnborð',
        text: 'Sjá allar bókanir dagsins.',
      },
    }),
  };
}

export function voicemailNotification(
  tenant: Tenant,
  details: { fromNumber: string; transcript: string; recordingUrl: string; receivedAt: Instant },
): RenderedEmail {
  const when = formatDateTimeIs(details.receivedAt, tenant.timezone, { year: true });

  return {
    subject: `Skilaboð úr símsvara — ${details.fromNumber}`,
    text: textBlock([
      `Símsvarinn tók við skilaboðum ${when}.`,
      '',
      `Frá: ${details.fromNumber}`,
      '',
      'Umritun:',
      details.transcript || '(engin umritun tiltæk)',
      '',
      details.recordingUrl && `Hlusta: ${details.recordingUrl}`,
    ]),
    html: layout({
      tenant,
      heading: 'Ný skilaboð úr símsvara',
      intro: `Símsvarinn tók við skilaboðum ${when}.`,
      rows: [
        ['Frá', details.fromNumber],
        ['Umritun', details.transcript || '(engin umritun tiltæk)'],
      ],
      ...(details.recordingUrl
        ? { callout: { url: details.recordingUrl, label: 'Hlusta á skilaboð', text: 'Upptakan er geymd hjá símaþjónustunni.' } }
        : {}),
    }),
  };
}

/** Sent to the business when their setup is complete. */
export function tenantWelcome(tenant: Tenant, details: { siteUrl: string; bookingUrl: string; features: string[] }): RenderedEmail {
  return {
    subject: `${tenant.name} er komið í loftið`,
    text: textBlock([
      `Sæl/l,`,
      '',
      `Uppsetningu á stafrænni þjónustu fyrir ${tenant.name} er lokið.`,
      '',
      `Vefsíða: ${details.siteUrl}`,
      `Bókunarsíða: ${details.bookingUrl}`,
      '',
      'Virkir eiginleikar:',
      ...details.features.map((feature) => `  · ${feature}`),
      '',
      'Hafðu samband ef eitthvað þarf að laga.',
      '',
      'Rafræn Þjónusta',
    ]),
    html: layout({
      tenant,
      heading: 'Þið eruð komin í loftið',
      intro: `Uppsetningu á stafrænni þjónustu fyrir ${tenant.name} er lokið.`,
      rows: [
        ['Vefsíða', details.siteUrl],
        ['Bókunarsíða', details.bookingUrl],
        ['Virkir eiginleikar', details.features.join(', ')],
      ],
      callout: { url: details.siteUrl, label: 'Skoða vefsíðuna', text: 'Svona lítur hún út fyrir viðskiptavini.' },
    }),
  };
}
