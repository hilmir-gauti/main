/**
 * Test helpers: an in-memory database and a fully-configured tenant.
 *
 * Every test file gets its own module registry (node:test runs files in
 * separate processes), so the database singleton in `core/db.ts` is safe to
 * open once per file.
 */

import { closeDatabase, openDatabase, run } from '../src/core/db.ts';
import { hhmmToMinutes, instantFromWallClock, type PlainDate } from '../src/core/time.ts';
import { applyPresetServices, createService, createStaff, setStaffServices } from '../src/domain/catalog.ts';
import { clearHandlers } from '../src/domain/events.ts';
import { setWeeklyHours } from '../src/domain/schedule.ts';
import { createTenant, updateTenant } from '../src/domain/tenants.ts';
import type { Service, Staff, Tenant } from '../src/domain/types.ts';

export const TZ = 'Atlantic/Reykjavik';

export function freshDatabase(): void {
  closeDatabase();
  openDatabase({ path: ':memory:' });
  clearHandlers();
}

/** Wall-clock helper: `at('2026-08-06', '09:00')` → epoch ms in Reykjavík. */
export function at(date: PlainDate, time: string, timezone = TZ): number {
  return instantFromWallClock(date, hhmmToMinutes(time), timezone);
}

export interface Fixture {
  tenant: Tenant;
  services: Service[];
  staff: Staff[];
}

export interface FixtureOptions {
  industry?: string;
  /** Mon–Fri 09:00–17:00 unless overridden. */
  hours?: Record<number, Array<[number, number]>>;
  minNoticeMin?: number;
  slotGranularityMin?: number;
  respectHolidays?: boolean;
  autoConfirm?: boolean;
}

const NINE_TO_FIVE: Record<number, Array<[number, number]>> = {
  1: [[540, 1020]], 2: [[540, 1020]], 3: [[540, 1020]],
  4: [[540, 1020]], 5: [[540, 1020]], 6: [], 7: [],
};

/**
 * A staff-led salon: one 60-minute service, one stylist, weekdays 09:00–17:00,
 * no lead-time requirement so tests can book "now".
 */
export function salonFixture(options: FixtureOptions = {}): Fixture {
  let tenant = createTenant({ name: 'Hárstofan Prófun', industry: options.industry ?? 'hargreidslustofa' });

  tenant = updateTenant(tenant.id, {
    minNoticeMin: options.minNoticeMin ?? 0,
    slotGranularityMin: options.slotGranularityMin ?? 30,
    respectHolidays: options.respectHolidays ?? false,
    autoConfirm: options.autoConfirm ?? true,
    maxAdvanceDays: 365,
  });

  setWeeklyHours(tenant.id, null, options.hours ?? NINE_TO_FIVE);

  const service = createService(tenant.id, {
    name: 'Klipping',
    durationMin: 60,
    priceIsk: 12900,
    requiresStaff: true,
  });

  const stylist = createStaff(tenant.id, { name: 'Anna Jónsdóttir', title: 'Hársnyrtir' });

  return { tenant, services: [service], staff: [stylist] };
}

/**
 * A resource-pool garage: no named staff, two bays, 60-minute service.
 */
export function garageFixture(options: { capacity?: number } = {}): Fixture {
  let tenant = createTenant({ name: 'Verkstæðið Prófun', industry: 'bilaverkstaedi' });
  tenant = updateTenant(tenant.id, {
    minNoticeMin: 0,
    slotGranularityMin: 30,
    respectHolidays: false,
    maxAdvanceDays: 365,
  });

  setWeeklyHours(tenant.id, null, NINE_TO_FIVE);

  const service = createService(tenant.id, {
    name: 'Smurþjónusta',
    durationMin: 60,
    priceIsk: 18900,
    requiresStaff: false,
    capacity: options.capacity ?? 2,
  });

  return { tenant, services: [service], staff: [] };
}

export function addStylist(tenant: Tenant, name: string, serviceIds: string[] = []): Staff {
  const staff = createStaff(tenant.id, { name });
  if (serviceIds.length > 0) setStaffServices(staff.id, serviceIds);
  return staff;
}

/** Times of day of the returned slots, as "HH:MM" strings, for readable assertions. */
export function slotTimes(slots: Array<{ startsAt: number }>, timezone = TZ): string[] {
  return slots.map((slot) => {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(new Date(slot.startsAt));
    return parts;
  });
}

export { applyPresetServices, run };
