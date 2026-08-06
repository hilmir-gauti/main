/**
 * Google Calendar synchronisation — the two-way half of the booking system.
 *
 * Outbound: every booking becomes an event in the tenant's calendar, so the
 * business sees appointments where they already look.
 *
 * Inbound: the tenant's own events (a dentist appointment, a supplier visit)
 * are imported as busy blocks, so the booking page stops offering times the
 * owner has already committed. Without this the calendar link would be
 * decorative — the whole point is that a personal entry closes a public slot.
 */

import { all, get, run, transaction } from '../../core/db.ts';
import { id } from '../../core/ids.ts';
import { logger } from '../../core/logger.ts';
import { DAY_MS, formatDateTimeIs, instantFromWallClock, toIsoWithZone, type Instant } from '../../core/time.ts';
import { config } from '../../config.ts';
import { attachCalendarEvent } from '../../domain/booking/bookings.ts';
import { formatAddress, getTenantOrThrow, isFeatureEnabled } from '../../domain/tenants.ts';
import type { BookingView } from '../../domain/types.ts';
import { requestJson } from '../http.ts';
import { getAccessToken, getGoogleAccount, isCalendarLinked, recordSyncResult } from './oauth.ts';

const API_BASE = 'https://www.googleapis.com/calendar/v3';

export interface CalendarListEntry {
  id: string;
  summary: string;
  primary: boolean;
  accessRole: string;
}

/** Calendars the linked account can write to, for the picker in settings. */
export async function listCalendars(tenantId: string): Promise<CalendarListEntry[]> {
  const accessToken = await getAccessToken(tenantId);
  const { data } = await requestJson<{ items?: Array<{ id: string; summary: string; primary?: boolean; accessRole: string }> }>(
    'google-calendar',
    `${API_BASE}/users/me/calendarList?minAccessRole=writer`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  );

  return (data?.items ?? []).map((item) => ({
    id: item.id,
    summary: item.summary,
    primary: item.primary === true,
    accessRole: item.accessRole,
  }));
}

// ---------------------------------------------------------------------------
// Outbound: bookings → calendar events
// ---------------------------------------------------------------------------

function eventPayload(booking: BookingView): Record<string, unknown> {
  const tenant = getTenantOrThrow(booking.tenantId);
  const location = formatAddress(tenant);

  const descriptionLines = [
    `Þjónusta: ${booking.serviceName}`,
    `Viðskiptavinur: ${booking.customerName}`,
    booking.customerPhone ? `Sími: ${booking.customerPhone}` : '',
    booking.customerEmail ? `Netfang: ${booking.customerEmail}` : '',
    booking.staffName ? `Starfsmaður: ${booking.staffName}` : '',
    booking.notes ? `\nAthugasemd viðskiptavinar:\n${booking.notes}` : '',
    '',
    `Bókað í gegnum Rafræna Þjónustu · ${config.baseUrl}/bokun/${booking.id}`,
  ].filter(Boolean);

  return {
    summary: `${booking.serviceName} — ${booking.customerName}`,
    description: descriptionLines.join('\n'),
    location,
    start: { dateTime: toIsoWithZone(booking.startsAt, tenant.timezone), timeZone: tenant.timezone },
    end: { dateTime: toIsoWithZone(booking.endsAt, tenant.timezone), timeZone: tenant.timezone },
    // Marks the slot busy for anyone checking the owner's freebusy.
    transparency: 'opaque',
    status: booking.status === 'afbokad' ? 'cancelled' : 'confirmed',
    // Lets us find our own events on the way back in, so a booking that was
    // pushed out is never re-imported as an external busy block.
    extendedProperties: {
      private: {
        rafraen_booking_id: booking.id,
        rafraen_tenant_id: booking.tenantId,
      },
    },
  };
}

/**
 * Creates or updates the calendar event for a booking.
 * Returns null when the tenant has not linked a calendar — that is a normal
 * state, not an error.
 */
export async function pushBooking(booking: BookingView): Promise<string | null> {
  if (!config.google.enabled) return null;
  if (!isFeatureEnabled(booking.tenantId, 'google_calendar')) return null;
  if (!isCalendarLinked(booking.tenantId)) return null;

  const account = getGoogleAccount(booking.tenantId)!;
  const calendarId = resolveCalendarId(booking, account.calendarId);

  try {
    const accessToken = await getAccessToken(booking.tenantId);
    const payload = eventPayload(booking);

    if (booking.googleEventId) {
      await requestJson('google-calendar', `${API_BASE}/calendars/${encodeURIComponent(booking.googleCalendarId || calendarId)}/events/${encodeURIComponent(booking.googleEventId)}`, {
        method: 'PATCH',
        headers: { authorization: `Bearer ${accessToken}` },
        body: JSON.stringify(payload),
        tolerate: [404],
      });
      recordSyncResult(booking.tenantId);
      return booking.googleEventId;
    }

    const { data } = await requestJson<{ id: string }>(
      'google-calendar',
      `${API_BASE}/calendars/${encodeURIComponent(calendarId)}/events`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}` },
        body: JSON.stringify(payload),
      },
    );

    if (data?.id) {
      attachCalendarEvent(booking.id, data.id, calendarId);
      recordSyncResult(booking.tenantId);
      logger.info('Bókun sett í Google-dagatal', { bookingId: booking.id, eventId: data.id });
      return data.id;
    }
    return null;
  } catch (error) {
    recordSyncResult(booking.tenantId, String(error));
    logger.error('Samstilling við Google-dagatal mistókst', { bookingId: booking.id, error });
    return null;
  }
}

/**
 * A staff member's own calendar wins over the shop calendar, so each stylist's
 * appointments land in the diary they actually check.
 */
function resolveCalendarId(booking: BookingView, fallback: string): string {
  if (!booking.staffId) return fallback || 'primary';
  const staffCalendar = get<{ google_calendar_id: string }>(
    'SELECT google_calendar_id FROM staff WHERE id = ?',
    booking.staffId,
  );
  return staffCalendar?.google_calendar_id || fallback || 'primary';
}

export async function removeBookingEvent(booking: BookingView): Promise<void> {
  if (!config.google.enabled || !booking.googleEventId) return;
  if (!isCalendarLinked(booking.tenantId)) return;

  try {
    const accessToken = await getAccessToken(booking.tenantId);
    await requestJson(
      'google-calendar',
      `${API_BASE}/calendars/${encodeURIComponent(booking.googleCalendarId || 'primary')}/events/${encodeURIComponent(booking.googleEventId)}`,
      {
        method: 'DELETE',
        headers: { authorization: `Bearer ${accessToken}` },
        // Already gone is the desired end state.
        tolerate: [404, 410],
      },
    );
    logger.info('Bókun fjarlægð úr Google-dagatali', { bookingId: booking.id });
  } catch (error) {
    logger.error('Tókst ekki að fjarlægja atburð úr Google-dagatali', { bookingId: booking.id, error });
  }
}

// ---------------------------------------------------------------------------
// Inbound: calendar events → busy blocks
// ---------------------------------------------------------------------------

interface GoogleEvent {
  id: string;
  status?: string;
  summary?: string;
  transparency?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  extendedProperties?: { private?: Record<string, string> };
  attendees?: Array<{ self?: boolean; responseStatus?: string }>;
}

/**
 * Imports the tenant's calendar events as busy blocks.
 *
 * Skipped events:
 *  - our own bookings (already represented, would double-block)
 *  - `transparency: transparent` — Google's "free" flag, e.g. reminders
 *  - declined invitations
 *
 * All-day events block the whole day, which is the right reading of "Sumarfrí".
 */
export async function syncBusyBlocks(
  tenantId: string,
  options: { daysAhead?: number; now?: Instant } = {},
): Promise<{ imported: number; skipped: number }> {
  if (!config.google.enabled || !isCalendarLinked(tenantId)) {
    return { imported: 0, skipped: 0 };
  }

  const tenant = getTenantOrThrow(tenantId);
  const account = getGoogleAccount(tenantId)!;
  const now = options.now ?? Date.now();
  const from = now;
  const to = now + (options.daysAhead ?? tenant.maxAdvanceDays) * DAY_MS;

  try {
    const accessToken = await getAccessToken(tenantId);
    const calendars = await calendarsToScan(tenantId, account.calendarId);

    let imported = 0;
    let skipped = 0;
    const seen: Array<{ calendarId: string; event: GoogleEvent }> = [];

    for (const calendarId of calendars) {
      const params = new URLSearchParams({
        timeMin: new Date(from).toISOString(),
        timeMax: new Date(to).toISOString(),
        singleEvents: 'true', // expands recurring events into instances
        maxResults: '2500',
        orderBy: 'startTime',
      });

      const { data } = await requestJson<{ items?: GoogleEvent[] }>(
        'google-calendar',
        `${API_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`,
        { headers: { authorization: `Bearer ${accessToken}` }, tolerate: [404] },
      );

      for (const event of data?.items ?? []) {
        seen.push({ calendarId, event });
      }
    }

    transaction(() => {
      // Replace the window wholesale: events deleted in Google must stop
      // blocking here, and diffing individually is not worth the complexity.
      run(
        "DELETE FROM external_busy WHERE tenant_id = ? AND source = 'google' AND starts_at < ? AND ends_at > ?",
        tenantId, to, from,
      );

      for (const { calendarId, event } of seen) {
        const interval = eventInterval(event, tenant.timezone);
        if (!interval) {
          skipped++;
          continue;
        }
        if (shouldSkip(event)) {
          skipped++;
          continue;
        }

        run(
          `INSERT INTO external_busy (id, tenant_id, staff_id, source, external_id, summary, starts_at, ends_at, synced_at)
           VALUES (?,?,?,'google',?,?,?,?,?)
           ON CONFLICT(tenant_id, source, external_id) WHERE external_id <> ''
           DO UPDATE SET starts_at = excluded.starts_at, ends_at = excluded.ends_at,
                         summary = excluded.summary, synced_at = excluded.synced_at`,
          id('upp'),
          tenantId,
          staffForCalendar(tenantId, calendarId),
          event.id,
          (event.summary ?? 'Upptekið').slice(0, 200),
          interval.start,
          interval.end,
          Date.now(),
        );
        imported++;
      }
    });

    recordSyncResult(tenantId);
    logger.info('Google-dagatal samstillt', { tenantId, imported, skipped });
    return { imported, skipped };
  } catch (error) {
    recordSyncResult(tenantId, String(error));
    logger.error('Samstilling frá Google-dagatali mistókst', { tenantId, error });
    return { imported: 0, skipped: 0 };
  }
}

function shouldSkip(event: GoogleEvent): boolean {
  if (event.status === 'cancelled') return true;
  // Our own bookings are already in the diary.
  if (event.extendedProperties?.private?.rafraen_booking_id) return true;
  // Google's "show me as available" flag.
  if (event.transparency === 'transparent') return true;
  // An invitation the owner declined does not occupy their time.
  if (event.attendees?.some((a) => a.self && a.responseStatus === 'declined')) return true;
  return false;
}

function eventInterval(event: GoogleEvent, timezone: string): { start: number; end: number } | null {
  if (event.start?.dateTime && event.end?.dateTime) {
    const start = Date.parse(event.start.dateTime);
    const end = Date.parse(event.end.dateTime);
    return Number.isFinite(start) && Number.isFinite(end) && end > start ? { start, end } : null;
  }

  // All-day events carry `date` (YYYY-MM-DD) with an exclusive end date.
  if (event.start?.date && event.end?.date) {
    const start = wallClockMidnight(event.start.date, timezone);
    const end = wallClockMidnight(event.end.date, timezone);
    return end > start ? { start, end } : null;
  }
  return null;
}

/** Midnight of an all-day event's date, in the tenant's timezone. */
function wallClockMidnight(date: string, timezone: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return Number.NaN;
  return instantFromWallClock(date, 0, timezone);
}

/** Which calendars to scan: the tenant's, plus any per-staff calendars. */
async function calendarsToScan(tenantId: string, defaultCalendarId: string): Promise<string[]> {
  const staffCalendars = all<{ google_calendar_id: string }>(
    "SELECT DISTINCT google_calendar_id FROM staff WHERE tenant_id = ? AND google_calendar_id <> '' AND active = 1",
    tenantId,
  ).map((row) => row.google_calendar_id);

  return [...new Set([defaultCalendarId || 'primary', ...staffCalendars])];
}

function staffForCalendar(tenantId: string, calendarId: string): string | null {
  const row = get<{ id: string }>(
    'SELECT id FROM staff WHERE tenant_id = ? AND google_calendar_id = ? AND active = 1',
    tenantId,
    calendarId,
  );
  return row?.id ?? null;
}

/** Human-readable sync status for the tenant detail page. */
export function calendarStatus(tenantId: string): { linked: boolean; email: string; calendarId: string; lastSync: string; error: string } {
  const account = getGoogleAccount(tenantId);
  if (!account) return { linked: false, email: '', calendarId: '', lastSync: 'Aldrei', error: '' };

  return {
    linked: Boolean(account.refreshToken),
    email: account.accountEmail,
    calendarId: account.calendarId,
    lastSync: account.lastSyncAt ? formatDateTimeIs(account.lastSyncAt, config.defaults.timezone) : 'Aldrei',
    error: account.lastError,
  };
}
