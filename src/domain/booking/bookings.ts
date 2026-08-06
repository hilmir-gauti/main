/**
 * Booking lifecycle: create, confirm, reschedule, cancel, complete.
 *
 * Two invariants govern everything here:
 *
 *  1. **No double-booking.** The slot is re-validated inside the same
 *     transaction that inserts the row, so two customers clicking the same
 *     09:00 at the same moment cannot both win. SQLite's `BEGIN IMMEDIATE`
 *     serialises the writers.
 *
 *  2. **Side effects happen after commit.** Calendar sync, email, SMS and push
 *     are triggered by domain events once the row is durable. A Google outage
 *     must never lose a booking the customer was told was confirmed.
 */

import { all, get, run, transaction } from '../../core/db.ts';
import { AppError, ValidationError, badRequest, conflict, notFound } from '../../core/errors.ts';
import { id, token } from '../../core/ids.ts';
import { logger } from '../../core/logger.ts';
import { MINUTE_MS, addDays, instantFromWallClock, plainDateOf, type Instant, type PlainDate } from '../../core/time.ts';
import { getServiceOrThrow } from '../catalog.ts';
import { findOrCreateCustomer, getCustomerOrThrow, recordNoShow, type CustomerInput } from '../customers.ts';
import { emit } from '../events.ts';
import { prepareIntake, saveBookingIntake } from '../intake/service.ts';
import type { IntakeAnswers } from '../intake/schema.ts';
import { getTenantOrThrow } from '../tenants.ts';
import {
  ACTIVE_BOOKING_STATUSES,
  type Booking,
  type BookingSource,
  type BookingStatus,
  type BookingView,
} from '../types.ts';
import { checkSlot, occupiedMs } from './availability.ts';

interface BookingRow {
  id: string; tenant_id: string; service_id: string; staff_id: string | null; customer_id: string;
  starts_at: number; ends_at: number; block_start_at: number; block_end_at: number;
  status: string; source: string; price_isk: number; notes: string; internal_notes: string;
  cancel_token: string; google_event_id: string; google_calendar_id: string;
  reminder_sent_at: number | null; confirmation_sent_at: number | null;
  cancelled_at: number | null; cancel_reason: string;
  created_at: number; updated_at: number;
}

interface BookingViewRow extends BookingRow {
  service_name: string; staff_name: string | null; customer_name: string;
  customer_phone: string; customer_email: string; tenant_name: string; tenant_timezone: string;
}

function toBooking(row: BookingRow): Booking {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    serviceId: row.service_id,
    staffId: row.staff_id,
    customerId: row.customer_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    blockStartAt: row.block_start_at,
    blockEndAt: row.block_end_at,
    status: row.status as BookingStatus,
    source: row.source as BookingSource,
    priceIsk: row.price_isk,
    notes: row.notes,
    internalNotes: row.internal_notes,
    cancelToken: row.cancel_token,
    googleEventId: row.google_event_id,
    googleCalendarId: row.google_calendar_id,
    reminderSentAt: row.reminder_sent_at,
    confirmationSentAt: row.confirmation_sent_at,
    cancelledAt: row.cancelled_at,
    cancelReason: row.cancel_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toBookingView(row: BookingViewRow): BookingView {
  return {
    ...toBooking(row),
    serviceName: row.service_name,
    staffName: row.staff_name,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    customerEmail: row.customer_email,
    tenantName: row.tenant_name,
    tenantTimezone: row.tenant_timezone,
  };
}

const VIEW_SQL = `
  SELECT b.*,
         sv.name  AS service_name,
         st.name  AS staff_name,
         c.name   AS customer_name,
         c.phone  AS customer_phone,
         c.email  AS customer_email,
         t.name   AS tenant_name,
         t.timezone AS tenant_timezone
    FROM booking b
    JOIN service  sv ON sv.id = b.service_id
    JOIN customer c  ON c.id  = b.customer_id
    JOIN tenant   t  ON t.id  = b.tenant_id
    LEFT JOIN staff st ON st.id = b.staff_id
`;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function getBooking(bookingId: string): BookingView | null {
  const row = get<BookingViewRow>(`${VIEW_SQL} WHERE b.id = ?`, bookingId);
  return row ? toBookingView(row) : null;
}

export function getBookingOrThrow(bookingId: string): BookingView {
  const booking = getBooking(bookingId);
  if (!booking) throw notFound('Bókun fannst ekki.');
  return booking;
}

/** Looks a booking up by the token embedded in cancellation links. */
export function getBookingByCancelToken(cancelToken: string): BookingView | null {
  const row = get<BookingViewRow>(`${VIEW_SQL} WHERE b.cancel_token = ?`, cancelToken);
  return row ? toBookingView(row) : null;
}

export interface ListBookingsOptions {
  from?: Instant;
  to?: Instant;
  status?: BookingStatus | BookingStatus[];
  staffId?: string;
  customerId?: string;
  serviceId?: string;
  limit?: number;
  order?: 'asc' | 'desc';
}

export function listBookings(tenantId: string, options: ListBookingsOptions = {}): BookingView[] {
  const clauses = ['b.tenant_id = ?'];
  const params: Array<string | number> = [tenantId];

  if (options.from !== undefined) {
    clauses.push('b.starts_at >= ?');
    params.push(options.from);
  }
  if (options.to !== undefined) {
    clauses.push('b.starts_at < ?');
    params.push(options.to);
  }
  if (options.status) {
    const statuses = Array.isArray(options.status) ? options.status : [options.status];
    clauses.push(`b.status IN (${statuses.map(() => '?').join(',')})`);
    params.push(...statuses);
  }
  if (options.staffId) {
    clauses.push('b.staff_id = ?');
    params.push(options.staffId);
  }
  if (options.customerId) {
    clauses.push('b.customer_id = ?');
    params.push(options.customerId);
  }
  if (options.serviceId) {
    clauses.push('b.service_id = ?');
    params.push(options.serviceId);
  }

  const limit = Math.min(options.limit ?? 200, 1000);
  params.push(limit);

  return all<BookingViewRow>(
    `${VIEW_SQL} WHERE ${clauses.join(' AND ')} ORDER BY b.starts_at ${options.order === 'desc' ? 'DESC' : 'ASC'} LIMIT ?`,
    ...params,
  ).map(toBookingView);
}

/** All bookings on one wall-clock day, for the diary view. */
export function bookingsOnDate(tenantId: string, date: PlainDate): BookingView[] {
  const tenant = getTenantOrThrow(tenantId);
  return listBookings(tenantId, {
    from: instantFromWallClock(date, 0, tenant.timezone),
    to: instantFromWallClock(addDays(date, 1), 0, tenant.timezone),
  });
}

export function upcomingBookings(tenantId: string, limit = 20, now: Instant = Date.now()): BookingView[] {
  return listBookings(tenantId, {
    from: now,
    status: ['beidni', 'stadfest'],
    limit,
  });
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreateBookingInput {
  tenantId: string;
  serviceId: string;
  staffId?: string | null;
  startsAt: Instant;
  customer: CustomerInput;
  notes?: string;
  internalNotes?: string;
  source?: BookingSource;
  /** Admin bookings bypass lead-time and max-advance limits. */
  ignorePolicy?: boolean;
  /** Answers to the industry intake questionnaire. */
  intake?: IntakeAnswers;
  /** Injected in tests. */
  now?: Instant;
}

export function createBooking(input: CreateBookingInput): BookingView {
  const tenant = getTenantOrThrow(input.tenantId);
  const service = getServiceOrThrow(input.serviceId);

  if (service.tenantId !== tenant.id) throw badRequest('Þjónustan tilheyrir ekki þessum viðskiptavini.');
  if (!service.active) throw badRequest('Þessi þjónusta er ekki í boði.');
  if (!Number.isFinite(input.startsAt)) throw badRequest('Ógildur tími.');

  const now = input.now ?? Date.now();
  const ignorePolicy = input.ignorePolicy ?? false;

  // Intake answers can lengthen the appointment (balayage, brakes front and
  // back), so they must be validated before a slot is checked.
  const intake = input.intake ? prepareIntake(tenant.id, input.intake) : null;
  if (intake && !intake.valid) throw new ValidationError(intake.errors);
  const extraMinutes = intake?.extraMinutes ?? 0;

  const booking = transaction(() => {
    // Re-check inside the transaction: this is what makes concurrent bookings
    // of the same slot safe.
    const check = checkSlot(tenant.id, service.id, input.startsAt, {
      staffId: input.staffId ?? null,
      now,
      ignorePolicy,
      extraMinutes,
    });

    if (!check.available) {
      throw conflict(check.reason ?? 'Þessi tími er ekki laus.', { startsAt: input.startsAt });
    }

    const customer = findOrCreateCustomer(tenant.id, input.customer);

    const bookingId = id('bok');
    const durationMs = (service.durationMin + extraMinutes) * MINUTE_MS;
    const blockStart = input.startsAt - service.bufferBeforeMin * MINUTE_MS;
    const blockEnd = input.startsAt + durationMs + service.bufferAfterMin * MINUTE_MS;
    const status: BookingStatus = tenant.autoConfirm ? 'stadfest' : 'beidni';

    run(
      `INSERT INTO booking (
         id, tenant_id, service_id, staff_id, customer_id,
         starts_at, ends_at, block_start_at, block_end_at,
         status, source, price_isk, notes, internal_notes, cancel_token,
         google_event_id, google_calendar_id, created_at, updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'','',?,?)`,
      bookingId,
      tenant.id,
      service.id,
      check.staffId,
      customer.id,
      input.startsAt,
      input.startsAt + durationMs,
      blockStart,
      blockEnd,
      status,
      input.source ?? 'vefur',
      service.priceIsk,
      input.notes?.trim().slice(0, 2000) ?? '',
      input.internalNotes?.trim().slice(0, 2000) ?? '',
      token(24),
      now,
      now,
    );

    if (intake) saveBookingIntake(bookingId, tenant.industry, intake.answers);

    return getBookingOrThrow(bookingId);
  });

  logger.info('Bókun stofnuð', {
    bookingId: booking.id,
    tenantId: tenant.id,
    serviceId: service.id,
    startsAt: new Date(booking.startsAt).toISOString(),
    source: booking.source,
  });

  void emit('booking.created', { booking });
  if (booking.status === 'stadfest') void emit('booking.confirmed', { booking });

  return booking;
}

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

/** Transitions that are allowed, keyed by current status. */
const ALLOWED_TRANSITIONS: Record<BookingStatus, BookingStatus[]> = {
  beidni: ['stadfest', 'afbokad'],
  stadfest: ['maett', 'lokid', 'afbokad', 'ekki_maett'],
  maett: ['lokid', 'afbokad'],
  lokid: [],
  afbokad: [],
  ekki_maett: [],
};

function assertTransition(from: BookingStatus, to: BookingStatus): void {
  if (from === to) return;
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new AppError(409, 'ogild_stadabreyting', `Ekki er hægt að breyta bókun úr stöðunni „${from}“ í „${to}“.`);
  }
}

export function confirmBooking(bookingId: string): BookingView {
  const existing = getBookingOrThrow(bookingId);
  assertTransition(existing.status, 'stadfest');

  run('UPDATE booking SET status = ?, updated_at = ? WHERE id = ?', 'stadfest', Date.now(), bookingId);
  const booking = getBookingOrThrow(bookingId);

  void emit('booking.confirmed', { booking });
  return booking;
}

export interface CancelOptions {
  reason?: string;
  cancelledBy?: 'vidskiptavinur' | 'fyrirtaeki' | 'kerfi';
  /** Enforce the tenant's cancellation window (customer-initiated only). */
  enforceWindow?: boolean;
  now?: Instant;
}

export function cancelBooking(bookingId: string, options: CancelOptions = {}): BookingView {
  const existing = getBookingOrThrow(bookingId);
  if (existing.status === 'afbokad') return existing;
  assertTransition(existing.status, 'afbokad');

  const now = options.now ?? Date.now();

  if (options.enforceWindow) {
    const tenant = getTenantOrThrow(existing.tenantId);
    const deadline = existing.startsAt - tenant.cancelWindowHours * 3_600_000;
    if (now > deadline) {
      throw new AppError(
        409,
        'utan_afbokunarfrests',
        `Ekki er hægt að afbóka með minna en ${tenant.cancelWindowHours} klst. fyrirvara. Hafðu samband við okkur í síma.`,
      );
    }
  }

  run(
    'UPDATE booking SET status = ?, cancelled_at = ?, cancel_reason = ?, updated_at = ? WHERE id = ?',
    'afbokad',
    now,
    options.reason?.trim().slice(0, 500) ?? '',
    now,
    bookingId,
  );

  const booking = getBookingOrThrow(bookingId);
  logger.info('Bókun afbókuð', { bookingId, cancelledBy: options.cancelledBy ?? 'kerfi' });

  void emit('booking.cancelled', {
    booking,
    reason: options.reason ?? '',
    cancelledBy: options.cancelledBy ?? 'kerfi',
  });

  return booking;
}

export interface RescheduleInput {
  startsAt: Instant;
  staffId?: string | null;
  ignorePolicy?: boolean;
  now?: Instant;
}

export function rescheduleBooking(bookingId: string, input: RescheduleInput): BookingView {
  const existing = getBookingOrThrow(bookingId);
  if (existing.status === 'afbokad' || existing.status === 'lokid' || existing.status === 'ekki_maett') {
    throw new AppError(409, 'ogild_stadabreyting', 'Ekki er hægt að færa bókun sem er lokið eða afbókuð.');
  }

  const service = getServiceOrThrow(existing.serviceId);
  const now = input.now ?? Date.now();
  const previousStartsAt = existing.startsAt;

  const booking = transaction(() => {
    const check = checkSlot(existing.tenantId, existing.serviceId, input.startsAt, {
      staffId: input.staffId ?? existing.staffId,
      now,
      ignorePolicy: input.ignorePolicy,
      // The booking's own time must not block moving it.
      excludeBookingId: bookingId,
    });

    if (!check.available) {
      throw conflict(check.reason ?? 'Þessi tími er ekki laus.', { startsAt: input.startsAt });
    }

    const durationMs = service.durationMin * MINUTE_MS;
    run(
      `UPDATE booking SET
         starts_at = ?, ends_at = ?, block_start_at = ?, block_end_at = ?,
         staff_id = ?, reminder_sent_at = NULL, updated_at = ?
       WHERE id = ?`,
      input.startsAt,
      input.startsAt + durationMs,
      input.startsAt - service.bufferBeforeMin * MINUTE_MS,
      input.startsAt + durationMs + service.bufferAfterMin * MINUTE_MS,
      check.staffId,
      now,
      bookingId,
    );

    return getBookingOrThrow(bookingId);
  });

  logger.info('Bókun færð', {
    bookingId,
    from: new Date(previousStartsAt).toISOString(),
    to: new Date(booking.startsAt).toISOString(),
  });

  void emit('booking.rescheduled', { booking, previousStartsAt });
  return booking;
}

export function markAttended(bookingId: string): BookingView {
  const existing = getBookingOrThrow(bookingId);
  assertTransition(existing.status, 'maett');
  run('UPDATE booking SET status = ?, updated_at = ? WHERE id = ?', 'maett', Date.now(), bookingId);
  return getBookingOrThrow(bookingId);
}

export function completeBooking(bookingId: string): BookingView {
  const existing = getBookingOrThrow(bookingId);
  assertTransition(existing.status, 'lokid');
  run('UPDATE booking SET status = ?, updated_at = ? WHERE id = ?', 'lokid', Date.now(), bookingId);

  const booking = getBookingOrThrow(bookingId);
  void emit('booking.completed', { booking });
  return booking;
}

export function markNoShow(bookingId: string): BookingView {
  const existing = getBookingOrThrow(bookingId);
  assertTransition(existing.status, 'ekki_maett');

  transaction(() => {
    run('UPDATE booking SET status = ?, updated_at = ? WHERE id = ?', 'ekki_maett', Date.now(), bookingId);
    recordNoShow(existing.customerId);
  });

  return getBookingOrThrow(bookingId);
}

export function updateBookingNotes(bookingId: string, internalNotes: string): BookingView {
  getBookingOrThrow(bookingId);
  run('UPDATE booking SET internal_notes = ?, updated_at = ? WHERE id = ?', internalNotes.slice(0, 2000), Date.now(), bookingId);
  return getBookingOrThrow(bookingId);
}

/** Records the Google Calendar event a booking was mirrored to. */
export function attachCalendarEvent(bookingId: string, eventId: string, calendarId: string): void {
  run(
    'UPDATE booking SET google_event_id = ?, google_calendar_id = ?, updated_at = ? WHERE id = ?',
    eventId,
    calendarId,
    Date.now(),
    bookingId,
  );
}

export function markConfirmationSent(bookingId: string): void {
  run('UPDATE booking SET confirmation_sent_at = ? WHERE id = ?', Date.now(), bookingId);
}

export function markReminderSent(bookingId: string): void {
  run('UPDATE booking SET reminder_sent_at = ? WHERE id = ?', Date.now(), bookingId);
}

/**
 * Bookings that are due a reminder: confirmed, starting within the reminder
 * window, and not yet reminded.
 */
export function bookingsDueReminder(hoursBefore: number, now: Instant = Date.now()): BookingView[] {
  const windowEnd = now + hoursBefore * 3_600_000;
  return all<BookingViewRow>(
    `${VIEW_SQL}
      WHERE b.status = 'stadfest'
        AND b.reminder_sent_at IS NULL
        AND b.starts_at > ?
        AND b.starts_at <= ?
      ORDER BY b.starts_at
      LIMIT 200`,
    now,
    windowEnd,
  ).map(toBookingView);
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

export interface BookingStats {
  today: number;
  upcoming: number;
  thisWeek: number;
  cancelledThisMonth: number;
  revenueThisMonthIsk: number;
}

export function bookingStats(tenantId: string, now: Instant = Date.now()): BookingStats {
  const tenant = getTenantOrThrow(tenantId);
  const todayDate = plainDateOf(now, tenant.timezone);
  const dayStart = instantFromWallClock(todayDate, 0, tenant.timezone);
  const dayEnd = instantFromWallClock(addDays(todayDate, 1), 0, tenant.timezone);
  const weekEnd = instantFromWallClock(addDays(todayDate, 7), 0, tenant.timezone);
  const monthStart = instantFromWallClock(`${todayDate.slice(0, 7)}-01`, 0, tenant.timezone);

  const activeList = ACTIVE_BOOKING_STATUSES.map(() => '?').join(',');

  const today = get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM booking WHERE tenant_id = ? AND starts_at >= ? AND starts_at < ? AND status IN (${activeList})`,
    tenantId, dayStart, dayEnd, ...ACTIVE_BOOKING_STATUSES,
  )?.c ?? 0;

  const upcoming = get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM booking WHERE tenant_id = ? AND starts_at >= ? AND status IN ('beidni','stadfest')`,
    tenantId, now,
  )?.c ?? 0;

  const thisWeek = get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM booking WHERE tenant_id = ? AND starts_at >= ? AND starts_at < ? AND status IN (${activeList})`,
    tenantId, dayStart, weekEnd, ...ACTIVE_BOOKING_STATUSES,
  )?.c ?? 0;

  const cancelledThisMonth = get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM booking WHERE tenant_id = ? AND cancelled_at >= ? AND status = 'afbokad'`,
    tenantId, monthStart,
  )?.c ?? 0;

  const revenue = get<{ s: number | null }>(
    `SELECT SUM(price_isk) AS s FROM booking
      WHERE tenant_id = ? AND starts_at >= ? AND status IN ('maett','lokid','stadfest')`,
    tenantId, monthStart,
  )?.s ?? 0;

  return { today, upcoming, thisWeek, cancelledThisMonth, revenueThisMonthIsk: revenue ?? 0 };
}
