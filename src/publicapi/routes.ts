/**
 * Public endpoints: the booking API consumed by generated websites, the
 * cancellation page customers reach from their confirmation email, and static
 * serving of generated sites.
 *
 * Everything here is unauthenticated and reachable from any origin, so it is
 * rate limited, validates every input, and never reveals more about a tenant
 * than their own website already shows.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { config } from '../config.ts';
import { badRequest, notFound } from '../core/errors.ts';
import { escapeHtml } from '../core/html.ts';
import { logger } from '../core/logger.ts';
import {
  addDays,
  formatDateIs,
  formatDateTimeIs,
  formatTimeIs,
  plainDateOf,
  weekdayNameIs,
  type PlainDate,
} from '../core/time.ts';
import { findAvailability } from '../domain/booking/availability.ts';
import { cancelBooking, createBooking, getBookingByCancelToken } from '../domain/booking/bookings.ts';
import { getServiceOrThrow } from '../domain/catalog.ts';
import { flowForIndustry } from '../domain/intake/flows.ts';
import { prepareIntake } from '../domain/intake/service.ts';
import { validateIntake, type IntakeAnswers } from '../domain/intake/schema.ts';
import { getTenantBySlug, getTenantOrThrow, isFeatureEnabled } from '../domain/tenants.ts';
import type { Tenant } from '../domain/types.ts';
import { suggestOptions } from '../integrations/ai/suggestions.ts';
import { publicCors, rateLimit } from '../http/middleware.ts';
import { htmlResponse, json, redirect, type HttpResponse } from '../http/response.ts';
import { Router } from '../http/router.ts';
import { widgetConfig } from '../website/generator.ts';

/** Resolves the tenant a public request refers to, rejecting inactive ones. */
function resolveTenant(slug: unknown): Tenant {
  if (typeof slug !== 'string' || !slug.trim()) throw badRequest('Vantar auðkenni fyrirtækis.');
  const tenant = getTenantBySlug(slug.trim());
  if (!tenant) throw notFound('Fyrirtækið fannst ekki.');
  if (tenant.status === 'haett') throw notFound('Fyrirtækið er ekki lengur með þjónustu.');
  return tenant;
}

function requireBookingEnabled(tenant: Tenant): void {
  if (!isFeatureEnabled(tenant.id, 'bokanir')) {
    throw badRequest('Netbókanir eru ekki virkar hjá þessu fyrirtæki.');
  }
}

export function publicRouter(): Router {
  const router = new Router();

  router.use(publicCors);

  // ---------------------------------------------------------------------
  // Booking widget API
  // ---------------------------------------------------------------------

  const apiLimit = rateLimit({ windowMs: 60_000, max: 60 });
  const writeLimit = rateLimit({ windowMs: 60_000, max: 10 });

  router.get('/api/vefur/uppsetning', (ctx) => {
    const tenant = resolveTenant(ctx.query.get('slug'));
    requireBookingEnabled(tenant);
    return json(widgetConfig(tenant.id), 200, { 'cache-control': 'public, max-age=60' });
  }, [apiLimit]);

  /**
   * A week of availability. The widget sends the answers so far so that
   * intake-derived extra time is reflected in the slots offered — a balayage
   * must not be shown a 30-minute gap.
   */
  router.post('/api/vefur/lausir-timar', (ctx) => {
    const body = ctx.body();
    const tenant = resolveTenant(body.slug);
    requireBookingEnabled(tenant);

    const service = getServiceOrThrow(String(body.serviceId ?? ''));
    if (service.tenantId !== tenant.id) throw badRequest('Þjónustan tilheyrir ekki þessu fyrirtæki.');

    const answers = (body.svor ?? {}) as IntakeAnswers;
    const flow = flowForIndustry(tenant.industry);
    const validation = validateIntake(flow, answers);

    if (!validation.valid) {
      return json({ villur: validation.errors, dagar: [] }, 200);
    }

    const weekOffset = Math.max(0, Math.min(Number(body.vika ?? 0) || 0, 52));
    const today = plainDateOf(Date.now(), tenant.timezone);
    const from: PlainDate = addDays(today, weekOffset * 7);
    const to: PlainDate = addDays(from, 6);

    const prepared = prepareIntake(tenant.id, answers);
    const days = findAvailability({
      tenantId: tenant.id,
      serviceId: service.id,
      from,
      to,
      limitPerDay: 24,
      extraMinutes: prepared.extraMinutes,
    });

    return json({
      villur: {},
      dagar: days.map((day) => ({
        dagsetning: day.date,
        vikudagur: weekdayNameIs(day.date, 'short'),
        dagsetningTexti: formatDateIs(day.date, { year: false, short: true }),
        lokad: day.closed,
        astaeda: day.closedReason,
        timar: day.slots.map((slot) => ({
          byrjar: slot.startsAt,
          timi: formatTimeIs(slot.startsAt, tenant.timezone),
          langurTexti: formatDateTimeIs(slot.startsAt, tenant.timezone, { year: false }),
          starfsmadurId: slot.staffId,
          starfsmadur: slot.staffName,
        })),
      })),
    });
  }, [apiLimit]);

  router.post('/api/vefur/bokun', async (ctx) => {
    const body = ctx.body();
    const tenant = resolveTenant(body.slug);
    requireBookingEnabled(tenant);

    const startsAt = Number(body.byrjar);
    if (!Number.isFinite(startsAt)) throw badRequest('Ógildur tími.');

    const booking = createBooking({
      tenantId: tenant.id,
      serviceId: String(body.serviceId ?? ''),
      staffId: body.starfsmadur ? String(body.starfsmadur) : null,
      startsAt,
      source: 'vefur',
      notes: typeof body.athugasemd === 'string' ? body.athugasemd : '',
      intake: (body.svor ?? {}) as IntakeAnswers,
      customer: {
        name: String(body.nafn ?? ''),
        phone: typeof body.simi === 'string' ? body.simi : '',
        email: typeof body.netfang === 'string' ? body.netfang : '',
      },
    });

    logger.info('Bókun í gegnum vefsíðu', { tenantId: tenant.id, bookingId: booking.id });

    return json({
      bokunId: booking.id,
      timi: formatDateTimeIs(booking.startsAt, tenant.timezone, { year: true }),
      skilabod: booking.customerEmail
        ? 'Staðfesting hefur verið send á netfangið þitt.'
        : 'Við sendum þér staðfestingu í SMS.',
      afbokunarslod: `${config.baseUrl}/afbokun/${booking.cancelToken}`,
    }, 201);
  }, [writeLimit]);

  /** AI-assisted style suggestions for the "describe it" branches. */
  router.post('/api/vefur/tillogur', async (ctx) => {
    const body = ctx.body();
    const tenant = resolveTenant(body.slug);

    const description = String(body.description ?? '').slice(0, 600);
    const subject = String(body.subject ?? 'útlit').slice(0, 60);

    const { suggestions, source } = await suggestOptions({
      subject,
      description,
      industry: tenant.industry,
      count: 3,
    });

    return json({
      uppruni: source,
      tillogur: suggestions.map((suggestion) => ({ titill: suggestion.title, lysing: suggestion.description })),
    });
  }, [rateLimit({ windowMs: 60_000, max: 12 })]);

  // ---------------------------------------------------------------------
  // Cancellation
  // ---------------------------------------------------------------------

  router.get('/afbokun/:token', (ctx) => {
    const booking = getBookingByCancelToken(ctx.params.token ?? '');
    if (!booking) return htmlResponse(cancelPage({ state: 'ekki_fundid' }), 404);

    if (booking.status === 'afbokad') {
      return htmlResponse(cancelPage({ state: 'thegar_afbokad', booking }));
    }

    return htmlResponse(cancelPage({ state: 'stadfesta', booking, csrfToken: ctx.params.token ?? '' }));
  }, [rateLimit({ windowMs: 60_000, max: 30 })]);

  router.post('/afbokun/:token', (ctx) => {
    const token = ctx.params.token ?? '';
    const booking = getBookingByCancelToken(token);
    if (!booking) return htmlResponse(cancelPage({ state: 'ekki_fundid' }), 404);

    try {
      const cancelled = cancelBooking(booking.id, {
        reason: String(ctx.form().astaeda ?? '').slice(0, 300),
        cancelledBy: 'vidskiptavinur',
        enforceWindow: true,
      });
      return htmlResponse(cancelPage({ state: 'afbokad', booking: cancelled }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Ekki tókst að afbóka.';
      return htmlResponse(cancelPage({ state: 'stadfesta', booking, error: message, csrfToken: token }), 409);
    }
  }, [rateLimit({ windowMs: 60_000, max: 10 })]);

  // ---------------------------------------------------------------------
  // Generated sites
  // ---------------------------------------------------------------------

  router.get('/v/:slug', (ctx) => serveSite(ctx.params.slug ?? '', 'index.html'));
  router.get('/v/:slug/:file', (ctx) => serveSite(ctx.params.slug ?? '', ctx.params.file ?? 'index.html'));

  return router;
}

// ---------------------------------------------------------------------------
// Static site serving
// ---------------------------------------------------------------------------

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
};

function serveSite(slug: string, file: string): HttpResponse {
  const tenant = getTenantBySlug(slug);
  if (!tenant) throw notFound('Vefsíðan fannst ekki.');

  // Reject anything that could escape the tenant's own directory.
  const safeFile = file.replace(/\\/g, '/').split('/').pop() ?? 'index.html';
  if (!/^[A-Za-z0-9._-]+$/.test(safeFile) || safeFile.startsWith('.')) {
    throw notFound('Skráin fannst ekki.');
  }

  const path = join(config.sitesDir, tenant.slug, 'vefur', safeFile);
  if (!existsSync(path)) {
    if (safeFile === 'index.html') {
      throw notFound('Vefsíðan hefur ekki verið birt ennþá.');
    }
    throw notFound('Skráin fannst ekki.');
  }

  const extension = safeFile.slice(safeFile.lastIndexOf('.')).toLowerCase();
  return {
    status: 200,
    headers: {
      'content-type': CONTENT_TYPES[extension] ?? 'application/octet-stream',
      'cache-control': 'public, max-age=300',
    },
    body: readFileSync(path),
  };
}

/**
 * Serves a wizard preview build. Mounted on the admin router, so it requires an
 * operator session — previews are unpublished drafts.
 */
export function servePreview(tenantId: string, variant: string): HttpResponse {
  const safeVariant = variant.replace(/[^a-z]/g, '');
  const tenant = getTenantOrThrow(tenantId);

  const path = join(config.sitesDir, tenant.slug, 'forskodun', safeVariant, 'index.html');
  if (!existsSync(path)) throw notFound('Forskoðun fannst ekki. Búðu til útgáfur fyrst.');

  return {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      // The console shows the three designs side by side in iframes, so this
      // one route relaxes the platform-wide framing ban — to same-origin only,
      // which keeps the clickjacking protection that ban exists for.
      'x-frame-options': 'SAMEORIGIN',
      'content-security-policy': [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: https:",
        "connect-src 'self'",
        "frame-ancestors 'self'",
      ].join('; '),
    },
    body: readFileSync(path),
  };
}

// ---------------------------------------------------------------------------
// Cancellation page
// ---------------------------------------------------------------------------

interface CancelPageOptions {
  state: 'stadfesta' | 'afbokad' | 'thegar_afbokad' | 'ekki_fundid';
  booking?: { serviceName: string; startsAt: number; tenantName: string; tenantTimezone: string; cancelToken: string };
  error?: string;
  csrfToken?: string;
}

function cancelPage(options: CancelPageOptions): string {
  const { booking } = options;
  const when = booking ? formatDateTimeIs(booking.startsAt, booking.tenantTimezone, { year: true }) : '';

  let heading = 'Afbóka tíma';
  let bodyHtml = '';

  if (options.state === 'ekki_fundid') {
    heading = 'Bókun fannst ekki';
    bodyHtml = '<p>Tengillinn er ógildur eða bókunin hefur verið fjarlægð.</p>';
  } else if (options.state === 'thegar_afbokad') {
    heading = 'Bókunin er þegar afbókuð';
    bodyHtml = `<p>Tíminn <strong>${escapeHtml(when)}</strong> hefur þegar verið afbókaður.</p>`;
  } else if (options.state === 'afbokad') {
    heading = 'Tíminn hefur verið afbókaður';
    bodyHtml = `
      <p>Við höfum afbókað tímann þinn ${escapeHtml(when)}.</p>
      <p class="muted">Takk fyrir að láta vita — það gerir öðrum kleift að nýta tímann.</p>`;
  } else {
    bodyHtml = `
      ${options.error ? `<div class="error">${escapeHtml(options.error)}</div>` : ''}
      <p>Viltu afbóka þennan tíma hjá <strong>${escapeHtml(booking?.tenantName ?? '')}</strong>?</p>
      <div class="card">
        <div><strong>${escapeHtml(booking?.serviceName ?? '')}</strong></div>
        <div class="muted">${escapeHtml(when)}</div>
      </div>
      <form method="post" action="/afbokun/${escapeHtml(options.csrfToken ?? '')}">
        <label for="astaeda">Ástæða (valfrjálst)</label>
        <input id="astaeda" name="astaeda" type="text" maxlength="200" placeholder="t.d. veikindi">
        <button type="submit">Staðfesta afbókun</button>
      </form>`;
  }

  return `<!doctype html>
<html lang="is"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(heading)}</title>
<style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:1.5rem;
     font:16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f1f5f9;color:#0f172a}
main{background:#fff;border-radius:16px;padding:2rem;max-width:30rem;width:100%;
     box-shadow:0 1px 3px rgba(15,23,42,.1)}
h1{font-size:1.5rem;margin:0 0 1rem}
.muted{color:#64748b}
.card{background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:1rem;margin:1rem 0}
.error{background:#fef2f2;border:1px solid #fecaca;color:#991b1b;border-radius:10px;padding:.85rem 1rem;margin-bottom:1rem}
label{display:block;font-weight:600;margin:1.25rem 0 .4rem}
input{width:100%;padding:.75rem .9rem;border:1px solid #cbd5e1;border-radius:10px;font:inherit}
button{margin-top:1.25rem;width:100%;padding:.85rem;border:0;border-radius:10px;background:#dc2626;color:#fff;
       font:inherit;font-weight:600;cursor:pointer}
button:hover{background:#b91c1c}
@media (prefers-color-scheme:dark){
  body{background:#0b1120;color:#e2e8f0}
  main{background:#131c2e}
  .card{background:#0f172a;border-color:#1e293b}
  input{background:#0f172a;border-color:#334155;color:inherit}
}
</style></head>
<body><main><h1>${escapeHtml(heading)}</h1>${bodyHtml}</main></body></html>`;
}

export { redirect };
