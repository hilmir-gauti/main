/**
 * Time handling.
 *
 * Two representations are used throughout the platform and never mixed:
 *  - `Instant`   — epoch milliseconds (UTC). Everything stored in the database.
 *  - `PlainDate` — "YYYY-MM-DD" wall-clock date in a tenant's timezone.
 *
 * Iceland (Atlantic/Reykjavik) sits on UTC year-round with no daylight saving,
 * which removes a whole class of booking bugs. We still do proper timezone
 * conversion rather than assuming it, so a tenant in another zone is handled
 * correctly and the code stays honest.
 */

export type Instant = number;
/** "YYYY-MM-DD" */
export type PlainDate = string;
/** ISO weekday: 1 = mánudagur … 7 = sunnudagur. */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;
/** Minutes since local midnight, 0–1440. */
export type MinuteOfDay = number;

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, fmt);
  }
  return fmt;
}

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number;
  minute: number;
  second: number;
}

/** Wall-clock parts of an instant, as seen in `timeZone`. */
export function zonedParts(instant: Instant, timeZone: string): ZonedParts {
  const parts = partsFormatter(timeZone).formatToParts(new Date(instant));
  const get = (type: string): number => Number.parseInt(parts.find((p) => p.type === type)?.value ?? '0', 10);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/** Offset in ms such that `localWallClock = utc + offset`. */
function zoneOffsetMs(instant: Instant, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asIfUtc - Math.floor(instant / 1000) * 1000;
}

/**
 * Converts a wall-clock date + minute-of-day in `timeZone` to an instant.
 *
 * The two-pass correction handles DST transitions: the first guess uses the
 * offset at the *approximate* moment, the second uses the offset at the
 * corrected moment. For times that fall in a DST gap this lands on the
 * instant immediately after the jump, which is the sane booking behaviour.
 */
export function instantFromWallClock(date: PlainDate, minuteOfDay: MinuteOfDay, timeZone: string): Instant {
  const [year, month, day] = splitDate(date);
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0, 0);

  let offset = zoneOffsetMs(naive, timeZone);
  let instant = naive - offset;
  offset = zoneOffsetMs(instant, timeZone);
  instant = naive - offset;
  return instant;
}

/** The wall-clock date an instant falls on, in `timeZone`. */
export function plainDateOf(instant: Instant, timeZone: string): PlainDate {
  const p = zonedParts(instant, timeZone);
  return `${p.year.toString().padStart(4, '0')}-${p.month.toString().padStart(2, '0')}-${p.day.toString().padStart(2, '0')}`;
}

/** Minutes since local midnight for an instant. */
export function minuteOfDayOf(instant: Instant, timeZone: string): MinuteOfDay {
  const p = zonedParts(instant, timeZone);
  return p.hour * 60 + p.minute;
}

export function splitDate(date: PlainDate): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new RangeError(`Ógild dagsetning: ${date}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function isValidPlainDate(date: string): date is PlainDate {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const [y, mo, d] = splitDate(date);
  const asUtc = new Date(Date.UTC(y, mo - 1, d));
  return asUtc.getUTCFullYear() === y && asUtc.getUTCMonth() === mo - 1 && asUtc.getUTCDate() === d;
}

export function addDays(date: PlainDate, days: number): PlainDate {
  const [y, mo, d] = splitDate(date);
  const next = new Date(Date.UTC(y, mo - 1, d + days));
  return `${next.getUTCFullYear().toString().padStart(4, '0')}-${(next.getUTCMonth() + 1)
    .toString()
    .padStart(2, '0')}-${next.getUTCDate().toString().padStart(2, '0')}`;
}

/** Whole days from `from` to `to` (may be negative). */
export function daysBetween(from: PlainDate, to: PlainDate): number {
  const [y1, m1, d1] = splitDate(from);
  const [y2, m2, d2] = splitDate(to);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / DAY_MS);
}

/** ISO weekday (1 = Monday … 7 = Sunday). */
export function weekdayOf(date: PlainDate): Weekday {
  const [y, mo, d] = splitDate(date);
  const js = new Date(Date.UTC(y, mo - 1, d)).getUTCDay(); // 0 = Sunday
  return (js === 0 ? 7 : js) as Weekday;
}

/** Today's wall-clock date in `timeZone`. */
export function today(timeZone: string, now: Instant = Date.now()): PlainDate {
  return plainDateOf(now, timeZone);
}

// ---------------------------------------------------------------------------
// Minute-of-day helpers
// ---------------------------------------------------------------------------

/** "09:30" → 570. Also accepts "9:30" and "0930". */
export function hhmmToMinutes(value: string): MinuteOfDay {
  const trimmed = value.trim();
  const m = /^(\d{1,2}):?(\d{2})$/.exec(trimmed);
  if (!m) throw new RangeError(`Ógildur tími: ${value}`);
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 24 || minutes > 59 || (hours === 24 && minutes > 0)) {
    throw new RangeError(`Ógildur tími: ${value}`);
  }
  return hours * 60 + minutes;
}

/** 570 → "09:30". 1440 renders as "24:00" (used for closing at midnight). */
export function minutesToHhmm(minutes: MinuteOfDay): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Icelandic formatting
//
// Hand-written rather than Intl-based: it guarantees correct Icelandic output
// regardless of the ICU data compiled into the host's Node build, and lets us
// use the grammatical forms Icelanders actually write on a booking confirmation.
// ---------------------------------------------------------------------------

const WEEKDAYS_IS = ['mánudagur', 'þriðjudagur', 'miðvikudagur', 'fimmtudagur', 'föstudagur', 'laugardagur', 'sunnudagur'];
const WEEKDAYS_IS_SHORT = ['mán', 'þri', 'mið', 'fim', 'fös', 'lau', 'sun'];
/** Accusative/dative form used after "á": "á mánudaginn". */
const WEEKDAYS_IS_DEFINITE = ['mánudaginn', 'þriðjudaginn', 'miðvikudaginn', 'fimmtudaginn', 'föstudaginn', 'laugardaginn', 'sunnudaginn'];
const MONTHS_IS = ['janúar', 'febrúar', 'mars', 'apríl', 'maí', 'júní', 'júlí', 'ágúst', 'september', 'október', 'nóvember', 'desember'];
const MONTHS_IS_SHORT = ['jan', 'feb', 'mar', 'apr', 'maí', 'jún', 'júl', 'ágú', 'sep', 'okt', 'nóv', 'des'];

export function weekdayNameIs(date: PlainDate, form: 'full' | 'short' | 'definite' = 'full'): string {
  const index = weekdayOf(date) - 1;
  const table = form === 'short' ? WEEKDAYS_IS_SHORT : form === 'definite' ? WEEKDAYS_IS_DEFINITE : WEEKDAYS_IS;
  return table[index]!;
}

export function monthNameIs(month: number, short = false): string {
  return (short ? MONTHS_IS_SHORT : MONTHS_IS)[month - 1] ?? '';
}

/** "6. ágúst 2026" */
export function formatDateIs(date: PlainDate, options: { year?: boolean; short?: boolean } = {}): string {
  const [y, mo, d] = splitDate(date);
  const month = monthNameIs(mo, options.short ?? false);
  return options.year === false ? `${d}. ${month}` : `${d}. ${month} ${y}`;
}

/** "fimmtudaginn 6. ágúst kl. 14:30" — the phrasing used in confirmations. */
export function formatDateTimeIs(instant: Instant, timeZone: string, options: { year?: boolean } = {}): string {
  const date = plainDateOf(instant, timeZone);
  const minutes = minuteOfDayOf(instant, timeZone);
  return `${weekdayNameIs(date, 'definite')} ${formatDateIs(date, { year: options.year ?? false })} kl. ${minutesToHhmm(minutes)}`;
}

/** "14:30" in the tenant's timezone. */
export function formatTimeIs(instant: Instant, timeZone: string): string {
  return minutesToHhmm(minuteOfDayOf(instant, timeZone));
}

/** "1 klst. 30 mín." */
export function formatDurationIs(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} mín.`;
  if (m === 0) return `${h} klst.`;
  return `${h} klst. ${m} mín.`;
}

/** Relative phrasing for notifications: "eftir 2 klst.", "á morgun". */
export function relativeIs(target: Instant, timeZone: string, now: Instant = Date.now()): string {
  const diffMs = target - now;
  const diffMin = Math.round(diffMs / MINUTE_MS);
  if (diffMin < -1) return 'liðið';
  if (diffMin <= 1) return 'núna';
  if (diffMin < 60) return `eftir ${diffMin} mín.`;

  const todayDate = plainDateOf(now, timeZone);
  const targetDate = plainDateOf(target, timeZone);
  const dayDiff = daysBetween(todayDate, targetDate);
  if (dayDiff === 0) return `eftir ${Math.round(diffMin / 60)} klst.`;
  if (dayDiff === 1) return `á morgun kl. ${formatTimeIs(target, timeZone)}`;
  if (dayDiff < 7) return `${weekdayNameIs(targetDate, 'definite')} kl. ${formatTimeIs(target, timeZone)}`;
  return formatDateIs(targetDate);
}

/** ISO 8601 in a specific zone, e.g. for Google Calendar payloads. */
export function toIsoWithZone(instant: Instant, timeZone: string): string {
  const p = zonedParts(instant, timeZone);
  const offsetMin = Math.round(zoneOffsetMs(instant, timeZone) / MINUTE_MS);
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const pad = (n: number, w = 2) => n.toString().padStart(w, '0');
  return (
    `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}
