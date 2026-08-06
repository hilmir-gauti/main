/**
 * Icelandic public holidays (lögbundnir frídagar).
 *
 * The booking engine consults this so a salon never offers an appointment on
 * föstudagurinn langi, and so Christmas Eve stops accepting bookings at midday
 * rather than at the usual closing time.
 *
 * Most holidays are fixed dates, but seven are tied to Easter and two are
 * "first weekday after X" rules, so they are computed rather than tabulated.
 */

import { addDays, splitDate, weekdayOf, type PlainDate } from './time.ts';

export type HolidayKind =
  /** Closed by law or by near-universal custom. */
  | 'frídagur'
  /** Open, but only until midday (aðfangadagur, gamlársdagur). */
  | 'hálfur'
  /** Not a day off — flagged only so the operator can decide. */
  | 'merkisdagur';

export interface Holiday {
  date: PlainDate;
  name: string;
  kind: HolidayKind;
  /** For half-days: the minute of day after which the business is closed. */
  closesAtMinute?: number;
}

/**
 * Anonymous Gregorian computus. Returns Easter Sunday for the given year.
 * Valid for all years in the Gregorian calendar.
 */
export function easterSunday(year: number): PlainDate {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
}

/**
 * Sumardagurinn fyrsti — "first day of summer", the first Thursday after
 * 18 April, so it always falls between the 19th and the 25th.
 */
export function firstDayOfSummer(year: number): PlainDate {
  let date: PlainDate = `${year}-04-19`;
  for (let i = 0; i < 7; i++) {
    if (weekdayOf(date) === 4) return date; // 4 = fimmtudagur
    date = addDays(date, 1);
  }
  /* c8 ignore next */
  return date;
}

/** Frídagur verslunarmanna — the first Monday of August. */
export function commerceDay(year: number): PlainDate {
  let date: PlainDate = `${year}-08-01`;
  for (let i = 0; i < 7; i++) {
    if (weekdayOf(date) === 1) return date;
    date = addDays(date, 1);
  }
  /* c8 ignore next */
  return date;
}

/** Mother's Day / Father's Day style observances are omitted — not days off. */
export function holidaysForYear(year: number): Holiday[] {
  const easter = easterSunday(year);
  const noon = 12 * 60;

  const list: Holiday[] = [
    { date: `${year}-01-01`, name: 'Nýársdagur', kind: 'frídagur' },
    { date: addDays(easter, -3), name: 'Skírdagur', kind: 'frídagur' },
    { date: addDays(easter, -2), name: 'Föstudagurinn langi', kind: 'frídagur' },
    { date: easter, name: 'Páskadagur', kind: 'frídagur' },
    { date: addDays(easter, 1), name: 'Annar í páskum', kind: 'frídagur' },
    { date: firstDayOfSummer(year), name: 'Sumardagurinn fyrsti', kind: 'frídagur' },
    { date: `${year}-05-01`, name: 'Verkalýðsdagurinn', kind: 'frídagur' },
    { date: addDays(easter, 39), name: 'Uppstigningardagur', kind: 'frídagur' },
    { date: addDays(easter, 49), name: 'Hvítasunnudagur', kind: 'frídagur' },
    { date: addDays(easter, 50), name: 'Annar í hvítasunnu', kind: 'frídagur' },
    { date: `${year}-06-17`, name: 'Þjóðhátíðardagurinn', kind: 'frídagur' },
    { date: commerceDay(year), name: 'Frídagur verslunarmanna', kind: 'frídagur' },
    { date: `${year}-12-24`, name: 'Aðfangadagur', kind: 'hálfur', closesAtMinute: noon },
    { date: `${year}-12-25`, name: 'Jóladagur', kind: 'frídagur' },
    { date: `${year}-12-26`, name: 'Annar í jólum', kind: 'frídagur' },
    { date: `${year}-12-31`, name: 'Gamlársdagur', kind: 'hálfur', closesAtMinute: noon },
  ];

  // Shrovetide days: not holidays, but a hair salon may want to know.
  list.push(
    { date: addDays(easter, -48), name: 'Bolludagur', kind: 'merkisdagur' },
    { date: addDays(easter, -47), name: 'Sprengidagur', kind: 'merkisdagur' },
    { date: addDays(easter, -46), name: 'Öskudagur', kind: 'merkisdagur' },
  );

  return list.sort((a, b) => a.date.localeCompare(b.date));
}

const cache = new Map<number, Map<PlainDate, Holiday>>();

function indexFor(year: number): Map<PlainDate, Holiday> {
  let index = cache.get(year);
  if (!index) {
    index = new Map(holidaysForYear(year).map((h) => [h.date, h]));
    cache.set(year, index);
  }
  return index;
}

/** Returns the holiday falling on `date`, or null. */
export function holidayOn(date: PlainDate): Holiday | null {
  const [year] = splitDate(date);
  return indexFor(year).get(date) ?? null;
}

/** True when a business would normally be closed all day. */
export function isClosedHoliday(date: PlainDate): boolean {
  return holidayOn(date)?.kind === 'frídagur';
}

/**
 * Closing time imposed by the calendar, or null when the day is unaffected.
 * Returns 0 for full closures so callers can treat both cases uniformly.
 */
export function holidayClosingMinute(date: PlainDate): number | null {
  const holiday = holidayOn(date);
  if (!holiday) return null;
  if (holiday.kind === 'frídagur') return 0;
  if (holiday.kind === 'hálfur') return holiday.closesAtMinute ?? 12 * 60;
  return null;
}

/** Upcoming holidays within `days`, for the dashboard's "framundan" panel. */
export function upcomingHolidays(from: PlainDate, days = 60): Holiday[] {
  const [startYear] = splitDate(from);
  const end = addDays(from, days);
  const [endYear] = splitDate(end);
  const years = startYear === endYear ? [startYear] : [startYear, endYear];
  return years
    .flatMap((y) => holidaysForYear(y))
    .filter((h) => h.date >= from && h.date <= end && h.kind !== 'merkisdagur')
    .sort((a, b) => a.date.localeCompare(b.date));
}
