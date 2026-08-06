/**
 * Availability engine.
 *
 * Given a service and a date range, produce the times a customer may actually
 * book. This is the single most important algorithm in the platform: the
 * website widget, the phone receptionist and the admin console all ask this
 * module the same question, so they can never disagree about what is free.
 *
 * Two scheduling models are supported, chosen by `service.requiresStaff`:
 *
 *   **Staff-led** (hairdresser, physiotherapist) — every appointment belongs to
 *   a named person. Each eligible staff member's own free time is computed
 *   independently and the results are merged.
 *
 *   **Resource-pool** (garage, tyre shop) — nobody is booked by name; what
 *   limits throughput is the number of bays. Concurrency across the tenant's
 *   unassigned bookings is capped at `service.capacity`, which onboarding sets
 *   from the "how many lifts?" answer.
 *
 * Buffers are handled by distinguishing the appointment the customer sees
 * (`startsAt`–`endsAt`) from the span the resource is occupied
 * (`blockStartAt`–`blockEndAt`). A 60-minute haircut with a 10-minute cleanup
 * buffer offers a 09:00 slot but blocks the diary until 10:10.
 */

import { all } from '../../core/db.ts';
import { badRequest } from '../../core/errors.ts';
import {
  clampAll,
  merge,
  sliceSlots,
  subtract,
  type Interval,
} from '../../core/intervals.ts';
import {
  DAY_MS,
  MINUTE_MS,
  addDays,
  daysBetween,
  instantFromWallClock,
  isValidPlainDate,
  plainDateOf,
  type Instant,
  type PlainDate,
} from '../../core/time.ts';
import { getServiceOrThrow, listStaff, staffForService } from '../catalog.ts';
import { dayWindows, loadScheduleContext, type ScheduleContext } from '../schedule.ts';
import { getTenantOrThrow } from '../tenants.ts';
import { ACTIVE_BOOKING_STATUSES, type AvailableSlot, type DayAvailability, type Service, type Staff, type Tenant } from '../types.ts';

export interface AvailabilityQuery {
  tenantId: string;
  serviceId: string;
  /** Restrict to one staff member; omit to search all eligible staff. */
  staffId?: string | null;
  from: PlainDate;
  to: PlainDate;
  /** Injected in tests; defaults to the current time. */
  now?: Instant;
  /** Cap on slots returned per day, to keep payloads small. */
  limitPerDay?: number;
  /** Ignore lead-time and max-advance rules (admin booking on behalf). */
  ignorePolicy?: boolean;
  /** Exclude a booking from the busy set, so rescheduling can reuse its slot. */
  excludeBookingId?: string;
  /**
   * Extra minutes implied by the intake answers (long hair, balayage, brakes
   * front *and* back). Added to the service's base duration so the slot that
   * is offered is the slot that is actually needed.
   */
  extraMinutes?: number;
}

/** Hard cap so a malformed range cannot ask for a decade of slots. */
const MAX_RANGE_DAYS = 120;

export function findAvailability(query: AvailabilityQuery): DayAvailability[] {
  const tenant = getTenantOrThrow(query.tenantId);
  const service = getServiceOrThrow(query.serviceId);

  if (service.tenantId !== tenant.id) throw badRequest('Þjónustan tilheyrir ekki þessum viðskiptavini.');
  if (!isValidPlainDate(query.from) || !isValidPlainDate(query.to)) throw badRequest('Ógild dagsetning.');

  const now = query.now ?? Date.now();
  const spanDays = daysBetween(query.from, query.to);
  if (spanDays < 0) throw badRequest('Lokadagur má ekki vera á undan upphafsdegi.');
  if (spanDays > MAX_RANGE_DAYS) throw badRequest(`Hámarksbil er ${MAX_RANGE_DAYS} dagar.`);

  // Policy bounds: nothing sooner than the notice period, nothing further out
  // than the tenant allows.
  const earliest = query.ignorePolicy ? now : now + tenant.minNoticeMin * MINUTE_MS;
  const latest = query.ignorePolicy
    ? Number.POSITIVE_INFINITY
    : now + tenant.maxAdvanceDays * DAY_MS;

  const scheduleCtx = loadScheduleContext(tenant.id, query.from, query.to);

  // One query for the whole range rather than one per day.
  const rangeStart = instantFromWallClock(query.from, 0, tenant.timezone);
  const rangeEnd = instantFromWallClock(addDays(query.to, 1), 0, tenant.timezone);
  const busy = loadBusy(tenant, rangeStart, rangeEnd, query.excludeBookingId);

  const eligibleStaff = resolveStaff(tenant, service, query.staffId ?? null);
  const extraMinutes = Math.max(0, Math.round(query.extraMinutes ?? 0));
  const totalDurationMs = occupiedMs(service, extraMinutes);
  const visibleDurationMs = (service.durationMin + extraMinutes) * MINUTE_MS;

  const days: DayAvailability[] = [];
  for (let date = query.from; date <= query.to; date = addDays(date, 1)) {
    days.push(
      service.requiresStaff && eligibleStaff.length > 0
        ? staffLedDay(tenant, service, date, eligibleStaff, scheduleCtx, busy, totalDurationMs, visibleDurationMs, earliest, latest, query.limitPerDay)
        : pooledDay(tenant, service, date, scheduleCtx, busy, totalDurationMs, visibleDurationMs, earliest, latest, query.limitPerDay),
    );
  }

  return days;
}

/** Total time the resource is occupied, including buffers on both sides. */
export function occupiedMs(service: Service, extraMinutes = 0): number {
  return (service.bufferBeforeMin + service.durationMin + extraMinutes + service.bufferAfterMin) * MINUTE_MS;
}

function resolveStaff(tenant: Tenant, service: Service, staffId: string | null): Staff[] {
  if (!service.requiresStaff) return [];

  const eligible = staffForService(tenant.id, service.id);
  if (!staffId) return eligible;

  const chosen = eligible.find((member) => member.id === staffId);
  if (chosen) return [chosen];

  // The requested person exists but is not eligible for this service.
  const exists = listStaff(tenant.id, { includeInactive: true }).some((member) => member.id === staffId);
  if (exists) return [];
  throw badRequest('Starfsmaður fannst ekki.');
}

// ---------------------------------------------------------------------------
// Busy time
// ---------------------------------------------------------------------------

interface BusySets {
  /** Occupied spans per staff id. */
  byStaff: Map<string, Interval[]>;
  /** Spans blocking the whole business (tenant-level external events). */
  shopWide: Interval[];
  /** Unassigned bookings, used for resource-pool concurrency counting. */
  pool: Interval[];
}

function loadBusy(tenant: Tenant, from: Instant, to: Instant, excludeBookingId?: string): BusySets {
  const statuses = ACTIVE_BOOKING_STATUSES.map(() => '?').join(',');
  const params: Array<string | number> = [tenant.id, to, from, ...ACTIVE_BOOKING_STATUSES];

  let sql =
    `SELECT staff_id, block_start_at, block_end_at FROM booking
      WHERE tenant_id = ? AND block_start_at < ? AND block_end_at > ?
        AND status IN (${statuses})`;
  if (excludeBookingId) {
    sql += ' AND id <> ?';
    params.push(excludeBookingId);
  }

  const bookings = all<{ staff_id: string | null; block_start_at: number; block_end_at: number }>(sql, ...params);

  const external = all<{ staff_id: string | null; starts_at: number; ends_at: number }>(
    `SELECT staff_id, starts_at, ends_at FROM external_busy
      WHERE tenant_id = ? AND starts_at < ? AND ends_at > ?`,
    tenant.id,
    to,
    from,
  );

  const byStaff = new Map<string, Interval[]>();
  const shopWide: Interval[] = [];
  const pool: Interval[] = [];

  const push = (staffId: string | null, interval: Interval, isBooking: boolean) => {
    if (staffId) {
      const list = byStaff.get(staffId) ?? [];
      list.push(interval);
      byStaff.set(staffId, list);
    } else if (isBooking) {
      pool.push(interval);
    } else {
      shopWide.push(interval);
    }
  };

  for (const row of bookings) {
    push(row.staff_id, { start: row.block_start_at, end: row.block_end_at }, true);
  }
  for (const row of external) {
    push(row.staff_id, { start: row.starts_at, end: row.ends_at }, false);
  }

  return { byStaff, shopWide, pool };
}

// ---------------------------------------------------------------------------
// Per-day computation
// ---------------------------------------------------------------------------

function windowsToIntervals(tenant: Tenant, date: PlainDate, windows: Array<{ openMin: number; closeMin: number }>): Interval[] {
  return windows.map((w) => ({
    start: instantFromWallClock(date, w.openMin, tenant.timezone),
    end: instantFromWallClock(date, w.closeMin, tenant.timezone),
  }));
}

function staffLedDay(
  tenant: Tenant,
  service: Service,
  date: PlainDate,
  staffMembers: Staff[],
  ctx: ScheduleContext,
  busy: BusySets,
  totalDurationMs: number,
  visibleDurationMs: number,
  earliest: Instant,
  latest: Instant,
  limitPerDay?: number,
): DayAvailability {
  const shop = dayWindows(tenant, date, null, ctx);
  if (shop.closed) {
    return { date, slots: [], closed: true, closedReason: shop.reason };
  }

  const shopIntervals = windowsToIntervals(tenant, date, shop.windows);
  const bufferBeforeMs = service.bufferBeforeMin * MINUTE_MS;
  const slotStep = Math.max(5, tenant.slotGranularityMin) * MINUTE_MS;

  // Deduplicate identical start times across staff, preferring the first
  // eligible member so the customer is not shown "09:00" five times.
  const seen = new Map<number, AvailableSlot>();

  for (const member of staffMembers) {
    const personal = dayWindows(tenant, date, member.id, ctx);
    if (personal.closed) continue;

    // A staff member can only work while the business is open.
    const working = clampAll(windowsToIntervals(tenant, date, personal.windows), {
      start: Math.min(...shopIntervals.map((i) => i.start)),
      end: Math.max(...shopIntervals.map((i) => i.end)),
    });
    const withinShop = intersectAll(working, shopIntervals);

    const blockers = merge([...(busy.byStaff.get(member.id) ?? []), ...busy.shopWide]);
    const free = subtract(withinShop, blockers);

    for (const window of free) {
      const alignAnchor = shopIntervals[0]?.start;
      for (const blockStart of sliceSlots(window, totalDurationMs, slotStep, alignAnchor)) {
        const startsAt = blockStart + bufferBeforeMs;
        if (startsAt < earliest || startsAt > latest) continue;
        if (seen.has(startsAt)) continue;
        seen.set(startsAt, {
          startsAt,
          endsAt: startsAt + visibleDurationMs,
          staffId: member.id,
          staffName: member.name,
        });
      }
    }
  }

  const slots = [...seen.values()].sort((a, b) => a.startsAt - b.startsAt);
  return {
    date,
    slots: limitPerDay ? slots.slice(0, limitPerDay) : slots,
    closed: slots.length === 0,
    closedReason: slots.length === 0 ? 'Enginn laus tími' : null,
  };
}

function pooledDay(
  tenant: Tenant,
  service: Service,
  date: PlainDate,
  ctx: ScheduleContext,
  busy: BusySets,
  totalDurationMs: number,
  visibleDurationMs: number,
  earliest: Instant,
  latest: Instant,
  limitPerDay?: number,
): DayAvailability {
  const shop = dayWindows(tenant, date, null, ctx);
  if (shop.closed) {
    return { date, slots: [], closed: true, closedReason: shop.reason };
  }

  const shopIntervals = windowsToIntervals(tenant, date, shop.windows);
  const bufferBeforeMs = service.bufferBeforeMin * MINUTE_MS;
  const slotStep = Math.max(5, tenant.slotGranularityMin) * MINUTE_MS;
  const capacity = Math.max(1, service.capacity);

  // Shop-wide external events close the pool entirely for their duration.
  const open = subtract(shopIntervals, busy.shopWide);

  const slots: AvailableSlot[] = [];
  for (const window of open) {
    for (const blockStart of sliceSlots(window, totalDurationMs, slotStep, shopIntervals[0]?.start)) {
      const startsAt = blockStart + bufferBeforeMs;
      if (startsAt < earliest || startsAt > latest) continue;

      const blockEnd = blockStart + totalDurationMs;
      const concurrent = busy.pool.filter((b) => b.start < blockEnd && blockStart < b.end).length;
      if (concurrent >= capacity) continue;

      slots.push({
        startsAt,
        endsAt: startsAt + visibleDurationMs,
        staffId: null,
        staffName: null,
      });
    }
  }

  slots.sort((a, b) => a.startsAt - b.startsAt);
  return {
    date,
    slots: limitPerDay ? slots.slice(0, limitPerDay) : slots,
    closed: slots.length === 0,
    closedReason: slots.length === 0 ? 'Enginn laus tími' : null,
  };
}

/** Intersects one interval list against another (both are merged first). */
function intersectAll(a: Interval[], b: Interval[]): Interval[] {
  if (a.length === 0 || b.length === 0) return [];
  const left = merge(a);
  const right = merge(b);
  const out: Interval[] = [];
  for (const x of left) {
    for (const y of right) {
      const start = Math.max(x.start, y.start);
      const end = Math.min(x.end, y.end);
      if (end > start) out.push({ start, end });
    }
  }
  return merge(out);
}

// ---------------------------------------------------------------------------
// Convenience queries
// ---------------------------------------------------------------------------

/**
 * The next `count` free slots from now, scanning forward day by day.
 * Used by the phone receptionist ("næsti lausi tími er á fimmtudaginn
 * klukkan tvö") and by the website's "fyrsti lausi tími" badge.
 */
export function nextAvailableSlots(
  tenantId: string,
  serviceId: string,
  count = 3,
  options: { staffId?: string | null; now?: Instant; maxDays?: number } = {},
): AvailableSlot[] {
  const tenant = getTenantOrThrow(tenantId);
  const now = options.now ?? Date.now();
  const maxDays = Math.min(options.maxDays ?? tenant.maxAdvanceDays, MAX_RANGE_DAYS);
  const startDate = plainDateOf(now, tenant.timezone);

  const found: AvailableSlot[] = [];
  // Scan in two-week chunks so a business closed for a month still resolves
  // without loading the whole horizon up front.
  for (let offset = 0; offset < maxDays && found.length < count; offset += 14) {
    const from = addDays(startDate, offset);
    const to = addDays(startDate, Math.min(offset + 13, maxDays));

    for (const day of findAvailability({ tenantId, serviceId, from, to, now, staffId: options.staffId ?? null })) {
      for (const slot of day.slots) {
        found.push(slot);
        if (found.length >= count) return found;
      }
    }
  }
  return found;
}

export interface SlotCheck {
  available: boolean;
  reason: string | null;
  /** Staff resolved for the slot, when the service is staff-led. */
  staffId: string | null;
}

/**
 * Verifies a specific start time immediately before writing a booking.
 *
 * `findAvailability` is what the customer browsed; this is the authority. The
 * two are kept consistent by checking membership in the generated slot list
 * rather than re-deriving the rules, so a slot can never be bookable here but
 * invisible there (or vice versa).
 */
export function checkSlot(
  tenantId: string,
  serviceId: string,
  startsAt: Instant,
  options: {
    staffId?: string | null;
    now?: Instant;
    ignorePolicy?: boolean;
    excludeBookingId?: string;
    extraMinutes?: number;
  } = {},
): SlotCheck {
  const tenant = getTenantOrThrow(tenantId);
  const date = plainDateOf(startsAt, tenant.timezone);

  const days = findAvailability({
    tenantId,
    serviceId,
    from: date,
    to: date,
    now: options.now,
    staffId: options.staffId ?? null,
    ignorePolicy: options.ignorePolicy,
    excludeBookingId: options.excludeBookingId,
    extraMinutes: options.extraMinutes,
  });

  const day = days[0];
  if (!day || day.closed) {
    return { available: false, reason: day?.closedReason ?? 'Lokað þennan dag.', staffId: null };
  }

  const match = day.slots.find((slot) => slot.startsAt === startsAt);
  if (!match) {
    return { available: false, reason: 'Þessi tími er ekki laus.', staffId: null };
  }

  return { available: true, reason: null, staffId: match.staffId };
}
