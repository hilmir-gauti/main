/**
 * API for the owner's phone app (iOS and Android).
 *
 * Authenticated with a device token issued during pairing, scoped to exactly
 * one tenant. The app can read its own diary and act on its own bookings —
 * nothing else in the platform is reachable with this credential.
 */

import { run } from '../core/db.ts';
import { unauthorized } from '../core/errors.ts';
import { normalizePhone } from '../core/iceland.ts';
import {
  addDays,
  formatDateIs,
  formatDateTimeIs,
  formatTimeIs,
  plainDateOf,
  relativeIs,
  type PlainDate,
} from '../core/time.ts';
import {
  bookingStats,
  bookingsOnDate,
  cancelBooking,
  completeBooking,
  confirmBooking,
  getBookingOrThrow,
  markAttended,
  markNoShow,
  upcomingBookings,
} from '../domain/booking/bookings.ts';
import { bookingAnswerSummary } from '../domain/intake/service.ts';
import { getTenantOrThrow } from '../domain/tenants.ts';
import type { BookingView } from '../domain/types.ts';
import { authenticateDevice, claimPairingCode, type Device, type Platform } from '../integrations/push/devices.ts';
import { publicCors, rateLimit } from '../http/middleware.ts';
import { json } from '../http/response.ts';
import { Router, type Middleware } from '../http/router.ts';
import type { RequestContext } from '../http/context.ts';

/** Resolves the bearer token to a paired device. */
const requireDevice: Middleware = async (ctx, next) => {
  const header = (ctx.headers.authorization ?? '').toString();
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  const device = authenticateDevice(token);

  if (!device) throw unauthorized('Tækið er ekki parað. Sláðu inn pörunarkóða aftur.');
  ctx.state.device = device;
  return next();
};

function device(ctx: RequestContext): Device {
  return ctx.state.device as Device;
}

/** The booking shape the app renders. */
function bookingPayload(booking: BookingView, timezone: string) {
  return {
    id: booking.id,
    byrjar: booking.startsAt,
    endar: booking.endsAt,
    timi: formatTimeIs(booking.startsAt, timezone),
    dagur: plainDateOf(booking.startsAt, timezone),
    hvenaer: relativeIs(booking.startsAt, timezone),
    thjonusta: booking.serviceName,
    starfsmadur: booking.staffName,
    stada: booking.status,
    uppruni: booking.source,
    verd: booking.priceIsk,
    vidskiptavinur: {
      nafn: booking.customerName,
      simi: booking.customerPhone ? normalizePhone(booking.customerPhone).display : '',
      simiE164: booking.customerPhone,
      netfang: booking.customerEmail,
    },
    athugasemd: booking.notes,
    innriAthugasemd: booking.internalNotes,
    // The intake answers are the reason the app is useful on the shop floor:
    // the mechanic sees the plate and the symptom before the car arrives.
    svor: bookingAnswerSummary(booking.id),
  };
}

export function mobileRouter(): Router {
  const router = new Router();
  router.use(publicCors);

  /** Pairing: exchanges a short code for a long-lived device token. */
  router.post('/api/app/para', (ctx) => {
    const body = ctx.body();
    const platform = String(body.kerfi ?? 'ios');

    const result = claimPairingCode(String(body.kodi ?? ''), {
      pushToken: String(body.pushToken ?? ''),
      platform: (platform === 'android' ? 'android' : platform === 'vefur' ? 'vefur' : 'ios') as Platform,
      label: typeof body.heiti === 'string' ? body.heiti : undefined,
    });

    return json({
      taeki: result.deviceId,
      lykill: result.deviceToken,
      fyrirtaeki: { id: result.tenantId, nafn: result.tenantName },
    }, 201);
  }, [rateLimit({ windowMs: 60_000, max: 10 })]);

  /** Updates the push token after an app reinstall or token rotation. */
  router.post('/api/app/tilkynningar', (ctx) => {
    const current = device(ctx);
    const body = ctx.body();
    const pushToken = String(body.pushToken ?? '').trim();
    if (pushToken) {
      // Written through the devices module's own table to keep the unique
      // index on push_token honest.
      updatePushToken(current.id, pushToken);
    }
    return json({ ok: true });
  }, [requireDevice]);

  /** Today's diary plus headline numbers — the app's home screen. */
  router.get('/api/app/yfirlit', (ctx) => {
    const current = device(ctx);
    const tenant = getTenantOrThrow(current.tenantId);
    const today = plainDateOf(Date.now(), tenant.timezone);

    const todaysBookings = bookingsOnDate(tenant.id, today).filter((booking) => booking.status !== 'afbokad');
    const stats = bookingStats(tenant.id);

    return json({
      fyrirtaeki: { id: tenant.id, nafn: tenant.name, tímabelti: tenant.timezone },
      dagur: { dagsetning: today, texti: formatDateIs(today) },
      tolur: {
        idag: stats.today,
        framundan: stats.upcoming,
        vikan: stats.thisWeek,
        veltaManadar: stats.revenueThisMonthIsk,
      },
      bokanir: todaysBookings.map((booking) => bookingPayload(booking, tenant.timezone)),
    });
  }, [requireDevice]);

  /** A specific day, for swiping through the calendar. */
  router.get('/api/app/dagur/:dagsetning', (ctx) => {
    const current = device(ctx);
    const tenant = getTenantOrThrow(current.tenantId);
    const date = (ctx.params.dagsetning ?? plainDateOf(Date.now(), tenant.timezone)) as PlainDate;

    const bookings = bookingsOnDate(tenant.id, date);
    return json({
      dagsetning: date,
      texti: formatDateIs(date),
      naesti: addDays(date, 1),
      fyrri: addDays(date, -1),
      bokanir: bookings.map((booking) => bookingPayload(booking, tenant.timezone)),
    });
  }, [requireDevice]);

  router.get('/api/app/framundan', (ctx) => {
    const current = device(ctx);
    const tenant = getTenantOrThrow(current.tenantId);
    const bookings = upcomingBookings(tenant.id, 50);

    return json({
      bokanir: bookings.map((booking) => ({
        ...bookingPayload(booking, tenant.timezone),
        langurTexti: formatDateTimeIs(booking.startsAt, tenant.timezone, { year: false }),
      })),
    });
  }, [requireDevice]);

  /** Acting on a booking from the phone: confirm, arrived, done, no-show, cancel. */
  router.post('/api/app/bokun/:id', (ctx) => {
    const current = device(ctx);
    const bookingId = ctx.params.id ?? '';
    const booking = getBookingOrThrow(bookingId);

    // A device may only touch its own tenant's bookings.
    if (booking.tenantId !== current.tenantId) throw unauthorized();

    const action = String(ctx.body().adgerd ?? '');
    let updated = booking;

    switch (action) {
      case 'stadfesta': updated = confirmBooking(bookingId); break;
      case 'maett': updated = markAttended(bookingId); break;
      case 'lokid': updated = completeBooking(bookingId); break;
      case 'ekki_maett': updated = markNoShow(bookingId); break;
      case 'afboka':
        updated = cancelBooking(bookingId, {
          cancelledBy: 'fyrirtaeki',
          reason: String(ctx.body().astaeda ?? 'Afbókað í appi'),
        });
        break;
      default:
        return json({ villa: 'ogild_adgerd', skilabod: 'Óþekkt aðgerð.' }, 400);
    }

    const tenant = getTenantOrThrow(current.tenantId);
    return json({ bokun: bookingPayload(updated, tenant.timezone) });
  }, [requireDevice]);

  return router;
}

/** Kept here rather than in devices.ts because it is an app-only concern. */
function updatePushToken(deviceId: string, pushToken: string): void {
  run('UPDATE device SET push_token = ?, last_seen_at = ?, active = 1 WHERE id = ?', pushToken, Date.now(), deviceId);
}
