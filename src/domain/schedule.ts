/**
 * Opening hours and calendar exceptions.
 *
 * Resolving "is this business open, and when" on a given date has a strict
 * precedence order, applied in `dayWindows`:
 *
 *   1. weekly opening hours (staff-specific if any exist, else tenant-wide)
 *   2. public holidays — closed, or clamped for half-days like aðfangadagur
 *   3. a tenant-level exception for that date
 *   4. a staff-level exception for that date
 *
 * Explicit exceptions come last on purpose: a garage that decides to open on
 * sumardagurinn fyrsti must be able to say so, and a hairdresser's holiday
 * must close their column even when the salon itself is open.
 */

import { all, get, run, transaction } from '../core/db.ts';
import { ValidationError } from '../core/errors.ts';
import { holidayClosingMinute, holidayOn } from '../core/holidays.ts';
import { id } from '../core/ids.ts';
import { isValidPlainDate, weekdayOf, type MinuteOfDay, type PlainDate, type Weekday } from '../core/time.ts';
import type { OpeningHours, ScheduleException, Tenant } from './types.ts';

interface HoursRow {
  id: string; tenant_id: string; staff_id: string | null;
  weekday: number; open_min: number; close_min: number;
}

interface ExceptionRow {
  id: string; tenant_id: string; staff_id: string | null; date: string;
  closed: number; open_min: number | null; close_min: number | null; note: string;
}

function toHours(row: HoursRow): OpeningHours {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    staffId: row.staff_id,
    weekday: row.weekday as Weekday,
    openMin: row.open_min,
    closeMin: row.close_min,
  };
}

function toException(row: ExceptionRow): ScheduleException {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    staffId: row.staff_id,
    date: row.date,
    closed: row.closed === 1,
    openMin: row.open_min,
    closeMin: row.close_min,
    note: row.note,
  };
}

/** A contiguous open window within one day, in minutes from local midnight. */
export interface DayWindow {
  openMin: MinuteOfDay;
  closeMin: MinuteOfDay;
}

export interface DaySchedule {
  date: PlainDate;
  windows: DayWindow[];
  closed: boolean;
  /** Human-readable explanation shown on the booking page when closed. */
  reason: string | null;
}

// ---------------------------------------------------------------------------
// Weekly opening hours
// ---------------------------------------------------------------------------

export function listOpeningHours(tenantId: string, staffId: string | null = null): OpeningHours[] {
  const rows = staffId
    ? all<HoursRow>('SELECT * FROM opening_hours WHERE tenant_id = ? AND staff_id = ? ORDER BY weekday, open_min', tenantId, staffId)
    : all<HoursRow>('SELECT * FROM opening_hours WHERE tenant_id = ? AND staff_id IS NULL ORDER BY weekday, open_min', tenantId);
  return rows.map(toHours);
}

/**
 * Replaces the whole weekly schedule for a tenant (or one staff member).
 * Passing an empty array for a weekday marks that day closed.
 */
export function setWeeklyHours(
  tenantId: string,
  staffId: string | null,
  schedule: Record<number, Array<[MinuteOfDay, MinuteOfDay]>>,
): void {
  const errors: Record<string, string> = {};

  for (const [weekdayStr, ranges] of Object.entries(schedule)) {
    const weekday = Number(weekdayStr);
    if (weekday < 1 || weekday > 7) {
      errors[`weekday_${weekdayStr}`] = 'Vikudagur verður að vera 1–7.';
      continue;
    }
    const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
    let previousEnd = -1;
    for (const [open, close] of sorted) {
      if (close <= open) {
        errors[`weekday_${weekday}`] = 'Lokunartími verður að vera á eftir opnunartíma.';
      } else if (open < previousEnd) {
        errors[`weekday_${weekday}`] = 'Opnunartímar mega ekki skarast.';
      }
      previousEnd = close;
    }
  }

  if (Object.keys(errors).length) throw new ValidationError(errors);

  transaction(() => {
    if (staffId) run('DELETE FROM opening_hours WHERE tenant_id = ? AND staff_id = ?', tenantId, staffId);
    else run('DELETE FROM opening_hours WHERE tenant_id = ? AND staff_id IS NULL', tenantId);

    for (const [weekdayStr, ranges] of Object.entries(schedule)) {
      for (const [openMin, closeMin] of ranges) {
        run(
          'INSERT INTO opening_hours (id, tenant_id, staff_id, weekday, open_min, close_min) VALUES (?,?,?,?,?,?)',
          id('opn'),
          tenantId,
          staffId,
          Number(weekdayStr),
          Math.round(openMin),
          Math.round(closeMin),
        );
      }
    }
  });
}

/** Weekly hours as a 1–7 keyed map, for rendering an opening-hours table. */
export function weeklyHoursMap(tenantId: string, staffId: string | null = null): Record<Weekday, DayWindow[]> {
  const map = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [] } as Record<Weekday, DayWindow[]>;
  for (const row of listOpeningHours(tenantId, staffId)) {
    map[row.weekday].push({ openMin: row.openMin, closeMin: row.closeMin });
  }
  return map;
}

// ---------------------------------------------------------------------------
// Exceptions
// ---------------------------------------------------------------------------

export interface ExceptionInput {
  date: PlainDate;
  staffId?: string | null;
  closed?: boolean;
  openMin?: MinuteOfDay;
  closeMin?: MinuteOfDay;
  note?: string;
}

export function addException(tenantId: string, input: ExceptionInput): ScheduleException {
  if (!isValidPlainDate(input.date)) {
    throw new ValidationError({ date: 'Dagsetning er ógild. Notaðu formið ÁÁÁÁ-MM-DD.' });
  }
  const closed = input.closed ?? true;
  if (!closed && (input.openMin === undefined || input.closeMin === undefined)) {
    throw new ValidationError({ openMin: 'Tilgreindu opnunar- og lokunartíma fyrir breyttan opnunartíma.' });
  }
  if (!closed && input.openMin !== undefined && input.closeMin !== undefined && input.closeMin <= input.openMin) {
    throw new ValidationError({ closeMin: 'Lokunartími verður að vera á eftir opnunartíma.' });
  }

  const exceptionId = id('und');
  run(
    `INSERT INTO schedule_exception (id, tenant_id, staff_id, date, closed, open_min, close_min, note, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    exceptionId,
    tenantId,
    input.staffId ?? null,
    input.date,
    closed,
    closed ? null : input.openMin ?? null,
    closed ? null : input.closeMin ?? null,
    input.note?.trim() ?? '',
    Date.now(),
  );

  return getException(exceptionId)!;
}

export function getException(exceptionId: string): ScheduleException | null {
  const row = get<ExceptionRow>('SELECT * FROM schedule_exception WHERE id = ?', exceptionId);
  return row ? toException(row) : null;
}

export function removeException(exceptionId: string): void {
  run('DELETE FROM schedule_exception WHERE id = ?', exceptionId);
}

export function listExceptions(tenantId: string, from?: PlainDate, to?: PlainDate): ScheduleException[] {
  if (from && to) {
    return all<ExceptionRow>(
      'SELECT * FROM schedule_exception WHERE tenant_id = ? AND date BETWEEN ? AND ? ORDER BY date',
      tenantId,
      from,
      to,
    ).map(toException);
  }
  return all<ExceptionRow>('SELECT * FROM schedule_exception WHERE tenant_id = ? ORDER BY date', tenantId).map(toException);
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Pre-fetched schedule data, so a 90-day availability scan hits the DB once. */
export interface ScheduleContext {
  tenantHours: Map<Weekday, DayWindow[]>;
  staffHours: Map<string, Map<Weekday, DayWindow[]>>;
  /** Keyed by `${date}` for tenant-level and `${date}|${staffId}` for staff. */
  exceptions: Map<string, ScheduleException>;
}

export function loadScheduleContext(tenantId: string, from: PlainDate, to: PlainDate): ScheduleContext {
  const tenantHours = new Map<Weekday, DayWindow[]>();
  const staffHours = new Map<string, Map<Weekday, DayWindow[]>>();

  for (const row of all<HoursRow>('SELECT * FROM opening_hours WHERE tenant_id = ? ORDER BY weekday, open_min', tenantId)) {
    const window = { openMin: row.open_min, closeMin: row.close_min };
    const weekday = row.weekday as Weekday;

    if (row.staff_id === null) {
      const list = tenantHours.get(weekday) ?? [];
      list.push(window);
      tenantHours.set(weekday, list);
    } else {
      let perStaff = staffHours.get(row.staff_id);
      if (!perStaff) {
        perStaff = new Map<Weekday, DayWindow[]>();
        staffHours.set(row.staff_id, perStaff);
      }
      const list = perStaff.get(weekday) ?? [];
      list.push(window);
      perStaff.set(weekday, list);
    }
  }

  const exceptions = new Map<string, ScheduleException>();
  for (const exception of listExceptions(tenantId, from, to)) {
    exceptions.set(exception.staffId ? `${exception.date}|${exception.staffId}` : exception.date, exception);
  }

  return { tenantHours, staffHours, exceptions };
}

/**
 * Resolves the open windows for one date, for the business as a whole
 * (`staffId = null`) or for one staff member.
 */
export function dayWindows(
  tenant: Tenant,
  date: PlainDate,
  staffId: string | null,
  ctx: ScheduleContext,
): DaySchedule {
  const weekday = weekdayOf(date);

  // 1. Weekly baseline. Staff hours override tenant hours only when the staff
  //    member has a schedule of their own; otherwise they inherit the shop's.
  const staffWeekly = staffId ? ctx.staffHours.get(staffId) : undefined;
  const baseline = (staffWeekly && staffWeekly.size > 0 ? staffWeekly.get(weekday) : ctx.tenantHours.get(weekday)) ?? [];
  let windows: DayWindow[] = baseline.map((w) => ({ ...w }));
  let reason: string | null = windows.length === 0 ? 'Lokað þennan vikudag' : null;

  // 2. Public holidays.
  if (tenant.respectHolidays) {
    const closingMinute = holidayClosingMinute(date);
    if (closingMinute !== null) {
      const holiday = holidayOn(date);
      if (closingMinute === 0) {
        windows = [];
        reason = holiday ? `Lokað — ${holiday.name}` : 'Lokað vegna frídags';
      } else {
        windows = windows
          .map((w) => ({ openMin: w.openMin, closeMin: Math.min(w.closeMin, closingMinute) }))
          .filter((w) => w.closeMin > w.openMin);
        if (windows.length === 0) reason = holiday ? `Lokað — ${holiday.name}` : 'Lokað vegna frídags';
      }
    }
  }

  // 3 & 4. Explicit exceptions override everything above, tenant first then staff.
  const tenantException = ctx.exceptions.get(date);
  const staffException = staffId ? ctx.exceptions.get(`${date}|${staffId}`) : undefined;

  for (const exception of [tenantException, staffException]) {
    if (!exception) continue;
    if (exception.closed) {
      windows = [];
      reason = exception.note || 'Lokað';
    } else if (exception.openMin !== null && exception.closeMin !== null) {
      windows = [{ openMin: exception.openMin, closeMin: exception.closeMin }];
      reason = null;
    }
  }

  return {
    date,
    windows: windows.sort((a, b) => a.openMin - b.openMin),
    closed: windows.length === 0,
    reason: windows.length === 0 ? reason ?? 'Lokað' : null,
  };
}

/** Applies an industry preset's weekly hours to a new tenant. */
export function applyPresetHours(tenantId: string, hours: Record<number, Array<[number, number]>>): void {
  const schedule: Record<number, Array<[number, number]>> = {};
  for (let weekday = 1; weekday <= 7; weekday++) {
    schedule[weekday] = hours[weekday] ?? [];
  }
  setWeeklyHours(tenantId, null, schedule);
}
