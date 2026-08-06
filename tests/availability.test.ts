/**
 * Availability engine tests.
 *
 * These cover the rules a real salon or garage depends on: buffers, breaks,
 * lead time, holidays, staff leave, capacity limits and double-booking.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { updateService } from '../src/domain/catalog.ts';
import { checkSlot, findAvailability, nextAvailableSlots } from '../src/domain/booking/availability.ts';
import { cancelBooking, createBooking, rescheduleBooking } from '../src/domain/booking/bookings.ts';
import { addException, setWeeklyHours } from '../src/domain/schedule.ts';
import { updateTenant } from '../src/domain/tenants.ts';
import { addStylist, at, freshDatabase, garageFixture, salonFixture, slotTimes } from './helpers.ts';

// A Thursday, deliberately far from any Icelandic holiday.
const THURSDAY = '2026-08-06';
const SATURDAY = '2026-08-08';

describe('findAvailability — grunnvirkni', () => {
  beforeEach(freshDatabase);

  it('býður tíma á hálftíma fresti innan opnunartíma', () => {
    const { tenant, services } = salonFixture();

    const [day] = findAvailability({
      tenantId: tenant.id,
      serviceId: services[0]!.id,
      from: THURSDAY,
      to: THURSDAY,
      now: at(THURSDAY, '00:01'),
    });

    assert.ok(day);
    assert.equal(day.closed, false);
    // 09:00–17:00 with a 60-minute service in 30-minute steps: last start 16:00.
    assert.deepEqual(slotTimes(day.slots), [
      '09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30',
      '13:00', '13:30', '14:00', '14:30', '15:00', '15:30', '16:00',
    ]);
  });

  it('lokar á dögum sem eru utan opnunartíma', () => {
    const { tenant, services } = salonFixture();

    const [day] = findAvailability({
      tenantId: tenant.id,
      serviceId: services[0]!.id,
      from: SATURDAY,
      to: SATURDAY,
      now: at(THURSDAY, '09:00'),
    });

    assert.ok(day);
    assert.equal(day.closed, true);
    assert.equal(day.slots.length, 0);
    assert.match(day.closedReason ?? '', /Lokað/);
  });

  it('virðir hádegishlé sem tvo aðskilda opnunarglugga', () => {
    const { tenant, services } = salonFixture({
      hours: { 1: [], 2: [], 3: [], 4: [[540, 720], [780, 1020]], 5: [], 6: [], 7: [] },
    });

    const [day] = findAvailability({
      tenantId: tenant.id,
      serviceId: services[0]!.id,
      from: THURSDAY,
      to: THURSDAY,
      now: at(THURSDAY, '00:01'),
    });

    // 09:00–12:00 fits starts at 09:00, 10:00, 11:00 (60-min service).
    // 13:00–17:00 fits 13:00 … 16:00. Nothing may straddle the break.
    assert.deepEqual(slotTimes(day!.slots), [
      '09:00', '09:30', '10:00', '10:30', '11:00',
      '13:00', '13:30', '14:00', '14:30', '15:00', '15:30', '16:00',
    ]);
  });
});

describe('findAvailability — biðtími og bókanir', () => {
  beforeEach(freshDatabase);

  it('felur tíma sem eru innan lágmarksfyrirvara', () => {
    const { tenant, services } = salonFixture({ minNoticeMin: 120 });

    const [day] = findAvailability({
      tenantId: tenant.id,
      serviceId: services[0]!.id,
      from: THURSDAY,
      to: THURSDAY,
      now: at(THURSDAY, '10:00'), // + 2 klst. fyrirvari => fyrst 12:00
    });

    assert.equal(slotTimes(day!.slots)[0], '12:00');
  });

  it('lokar á tíma sem skarast við staðfesta bókun', () => {
    const { tenant, services } = salonFixture();
    const now = at(THURSDAY, '08:00');

    createBooking({
      tenantId: tenant.id,
      serviceId: services[0]!.id,
      startsAt: at(THURSDAY, '10:00'),
      customer: { name: 'Jón Jónsson', phone: '5551234' },
      now,
    });

    const [day] = findAvailability({
      tenantId: tenant.id, serviceId: services[0]!.id, from: THURSDAY, to: THURSDAY, now,
    });

    const times = slotTimes(day!.slots);
    // The 10:00 booking occupies 10:00–11:00, so 09:30 and 10:00 and 10:30 go.
    assert.ok(!times.includes('10:00'));
    assert.ok(!times.includes('10:30'));
    assert.ok(!times.includes('09:30'), 'tími sem myndi skarast má ekki birtast');
    assert.ok(times.includes('09:00'));
    assert.ok(times.includes('11:00'));
  });

  it('skilar tíma aftur eftir afbókun', () => {
    const { tenant, services } = salonFixture();
    const now = at(THURSDAY, '08:00');

    const booking = createBooking({
      tenantId: tenant.id,
      serviceId: services[0]!.id,
      startsAt: at(THURSDAY, '10:00'),
      customer: { name: 'Jón Jónsson', phone: '5551234' },
      now,
    });

    cancelBooking(booking.id, { cancelledBy: 'vidskiptavinur' });

    const [day] = findAvailability({
      tenantId: tenant.id, serviceId: services[0]!.id, from: THURSDAY, to: THURSDAY, now,
    });
    assert.ok(slotTimes(day!.slots).includes('10:00'));
  });

  it('reiknar biðtíma eftir þjónustu inn í upptekinn tíma', () => {
    const { tenant, services } = salonFixture();
    // 60-minute service with a 15-minute cleanup buffer occupies 75 minutes.
    updateService(services[0]!.id, { bufferAfterMin: 15 });
    const now = at(THURSDAY, '08:00');

    createBooking({
      tenantId: tenant.id,
      serviceId: services[0]!.id,
      startsAt: at(THURSDAY, '10:00'),
      customer: { name: 'Jón Jónsson', phone: '5551234' },
      now,
    });

    const [day] = findAvailability({
      tenantId: tenant.id, serviceId: services[0]!.id, from: THURSDAY, to: THURSDAY, now,
    });

    const times = slotTimes(day!.slots);
    // Booking blocks 10:00–11:15, so the next start that fits is 11:30.
    assert.ok(!times.includes('11:00'));
    assert.ok(times.includes('11:30'));
  });
});

describe('findAvailability — starfsfólk', () => {
  beforeEach(freshDatabase);

  it('býður áfram tíma þegar annar starfsmaður er laus', () => {
    const { tenant, services } = salonFixture();
    addStylist(tenant, 'Björk Ólafsdóttir');
    const now = at(THURSDAY, '08:00');

    createBooking({
      tenantId: tenant.id,
      serviceId: services[0]!.id,
      startsAt: at(THURSDAY, '10:00'),
      customer: { name: 'Jón Jónsson', phone: '5551234' },
      now,
    });

    const [day] = findAvailability({
      tenantId: tenant.id, serviceId: services[0]!.id, from: THURSDAY, to: THURSDAY, now,
    });

    // The second stylist is still free at 10:00.
    assert.ok(slotTimes(day!.slots).includes('10:00'));
  });

  it('lokar á tíma þegar allir starfsmenn eru bókaðir', () => {
    const { tenant, services } = salonFixture();
    addStylist(tenant, 'Björk Ólafsdóttir');
    const now = at(THURSDAY, '08:00');

    for (let i = 0; i < 2; i++) {
      createBooking({
        tenantId: tenant.id,
        serviceId: services[0]!.id,
        startsAt: at(THURSDAY, '10:00'),
        customer: { name: `Kúnni ${i}`, phone: `555000${i}` },
        now,
      });
    }

    const [day] = findAvailability({
      tenantId: tenant.id, serviceId: services[0]!.id, from: THURSDAY, to: THURSDAY, now,
    });
    assert.ok(!slotTimes(day!.slots).includes('10:00'));
  });

  it('tekur tillit til frídags eins starfsmanns', () => {
    const { tenant, services, staff } = salonFixture();
    addException(tenant.id, { date: THURSDAY, staffId: staff[0]!.id, closed: true, note: 'Sumarfrí' });

    const [day] = findAvailability({
      tenantId: tenant.id,
      serviceId: services[0]!.id,
      from: THURSDAY,
      to: THURSDAY,
      now: at(THURSDAY, '00:01'),
    });

    assert.equal(day!.slots.length, 0, 'eini starfsmaðurinn er í fríi');
  });

  it('takmarkar við valinn starfsmann þegar hann er tilgreindur', () => {
    const { tenant, services, staff } = salonFixture();
    const second = addStylist(tenant, 'Björk Ólafsdóttir');
    addException(tenant.id, { date: THURSDAY, staffId: second.id, closed: true, note: 'Frí' });

    const forSecond = findAvailability({
      tenantId: tenant.id, serviceId: services[0]!.id, staffId: second.id,
      from: THURSDAY, to: THURSDAY, now: at(THURSDAY, '00:01'),
    });
    assert.equal(forSecond[0]!.slots.length, 0);

    const forFirst = findAvailability({
      tenantId: tenant.id, serviceId: services[0]!.id, staffId: staff[0]!.id,
      from: THURSDAY, to: THURSDAY, now: at(THURSDAY, '00:01'),
    });
    assert.ok(forFirst[0]!.slots.length > 0);
  });
});

describe('findAvailability — frídagar og undantekningar', () => {
  beforeEach(freshDatabase);

  it('lokar á lögbundnum frídegi þegar virt er', () => {
    const { tenant, services } = salonFixture({ respectHolidays: true });
    // 17. júní 2026 er miðvikudagur — þjóðhátíðardagurinn.
    const nationalDay = '2026-06-17';

    const [day] = findAvailability({
      tenantId: tenant.id, serviceId: services[0]!.id,
      from: nationalDay, to: nationalDay, now: at('2026-06-01', '09:00'),
    });

    assert.equal(day!.closed, true);
    assert.match(day!.closedReason ?? '', /Þjóðhátíðardagurinn/);
  });

  it('styttir opnun á aðfangadag', () => {
    const { tenant, services } = salonFixture({ respectHolidays: true });
    // 24. desember 2026 er fimmtudagur.
    const christmasEve = '2026-12-24';

    const [day] = findAvailability({
      tenantId: tenant.id, serviceId: services[0]!.id,
      from: christmasEve, to: christmasEve, now: at('2026-12-01', '09:00'),
    });

    const times = slotTimes(day!.slots);
    assert.ok(times.includes('09:00'));
    // Closes at 12:00, so a 60-minute service cannot start after 11:00.
    assert.ok(!times.includes('11:30'));
    assert.equal(times[times.length - 1], '11:00');
  });

  it('leyfir opnun á frídegi með undantekningu', () => {
    const { tenant, services } = salonFixture({ respectHolidays: true });
    const nationalDay = '2026-06-17';
    addException(tenant.id, { date: nationalDay, closed: false, openMin: 600, closeMin: 840, note: 'Opið á 17. júní' });

    const [day] = findAvailability({
      tenantId: tenant.id, serviceId: services[0]!.id,
      from: nationalDay, to: nationalDay, now: at('2026-06-01', '09:00'),
    });

    assert.equal(day!.closed, false);
    assert.equal(slotTimes(day!.slots)[0], '10:00');
  });
});

describe('findAvailability — afkastageta (verkstæði)', () => {
  beforeEach(freshDatabase);

  it('leyfir bókanir upp að afkastagetu á sama tíma', () => {
    const { tenant, services } = garageFixture({ capacity: 2 });
    const now = at(THURSDAY, '08:00');

    createBooking({
      tenantId: tenant.id, serviceId: services[0]!.id, startsAt: at(THURSDAY, '10:00'),
      customer: { name: 'Bíll eitt', phone: '5551111' }, now,
    });

    let [day] = findAvailability({
      tenantId: tenant.id, serviceId: services[0]!.id, from: THURSDAY, to: THURSDAY, now,
    });
    assert.ok(slotTimes(day!.slots).includes('10:00'), 'annað stæði er enn laust');

    createBooking({
      tenantId: tenant.id, serviceId: services[0]!.id, startsAt: at(THURSDAY, '10:00'),
      customer: { name: 'Bíll tvö', phone: '5552222' }, now,
    });

    [day] = findAvailability({
      tenantId: tenant.id, serviceId: services[0]!.id, from: THURSDAY, to: THURSDAY, now,
    });
    assert.ok(!slotTimes(day!.slots).includes('10:00'), 'bæði stæði eru upptekin');
  });
});

describe('checkSlot og bókanaárekstrar', () => {
  beforeEach(freshDatabase);

  it('hafnar tvíbókun á sama tíma', () => {
    const { tenant, services } = salonFixture();
    const now = at(THURSDAY, '08:00');
    const startsAt = at(THURSDAY, '11:00');

    createBooking({
      tenantId: tenant.id, serviceId: services[0]!.id, startsAt,
      customer: { name: 'Fyrri', phone: '5551111' }, now,
    });

    assert.throws(
      () =>
        createBooking({
          tenantId: tenant.id, serviceId: services[0]!.id, startsAt,
          customer: { name: 'Seinni', phone: '5552222' }, now,
        }),
      /ekki laus/i,
    );
  });

  it('hafnar tíma utan opnunartíma', () => {
    const { tenant, services } = salonFixture();
    const check = checkSlot(tenant.id, services[0]!.id, at(THURSDAY, '20:00'), { now: at(THURSDAY, '08:00') });
    assert.equal(check.available, false);
  });

  it('leyfir að færa bókun á tíma sem hún sjálf lokaði á', () => {
    const { tenant, services } = salonFixture();
    const now = at(THURSDAY, '08:00');

    const booking = createBooking({
      tenantId: tenant.id, serviceId: services[0]!.id, startsAt: at(THURSDAY, '10:00'),
      customer: { name: 'Jón', phone: '5551234' }, now,
    });

    // Moving 30 minutes later overlaps the booking's own current block.
    const moved = rescheduleBooking(booking.id, { startsAt: at(THURSDAY, '10:30'), now });
    assert.equal(moved.startsAt, at(THURSDAY, '10:30'));
  });
});

describe('nextAvailableSlots', () => {
  beforeEach(freshDatabase);

  it('finnur næstu lausu tíma yfir helgi', () => {
    const { tenant, services } = salonFixture();
    // Föstudagur kl. 16:30 — næsti tími ætti að vera á mánudagsmorgni.
    const friday = '2026-08-07';
    const slots = nextAvailableSlots(tenant.id, services[0]!.id, 2, { now: at(friday, '16:30') });

    assert.equal(slots.length, 2);
    const first = new Date(slots[0]!.startsAt).toISOString();
    assert.ok(first.startsWith('2026-08-10'), `bjóst við mánudegi, fékk ${first}`);
  });

  it('skilar engum tímum þegar allt er lokað', () => {
    const { tenant, services } = salonFixture({
      hours: { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [] },
    });
    const slots = nextAvailableSlots(tenant.id, services[0]!.id, 3, { now: at(THURSDAY, '09:00'), maxDays: 30 });
    assert.equal(slots.length, 0);
  });
});

describe('reglur um hámarksfyrirvara', () => {
  beforeEach(freshDatabase);

  it('felur tíma lengra fram í tímann en leyft er', () => {
    const { tenant, services } = salonFixture();
    updateTenant(tenant.id, { maxAdvanceDays: 7 });

    const farOut = '2026-09-10';
    const [day] = findAvailability({
      tenantId: tenant.id, serviceId: services[0]!.id,
      from: farOut, to: farOut, now: at(THURSDAY, '09:00'),
    });

    assert.equal(day!.slots.length, 0);
  });

  it('hunsar reglur þegar stjórnandi bókar', () => {
    const { tenant, services } = salonFixture({ minNoticeMin: 600 });

    const [day] = findAvailability({
      tenantId: tenant.id, serviceId: services[0]!.id,
      from: THURSDAY, to: THURSDAY, now: at(THURSDAY, '09:00'), ignorePolicy: true,
    });

    assert.ok(slotTimes(day!.slots).includes('09:00'));
  });
});

describe('opnunartímar starfsmanns', () => {
  beforeEach(freshDatabase);

  it('takmarkast við opnunartíma fyrirtækisins', () => {
    const { tenant, services, staff } = salonFixture();
    // Stylist wants 07:00–20:00 but the salon is only open 09:00–17:00.
    setWeeklyHours(tenant.id, staff[0]!.id, {
      1: [[420, 1200]], 2: [[420, 1200]], 3: [[420, 1200]],
      4: [[420, 1200]], 5: [[420, 1200]], 6: [], 7: [],
    });

    const [day] = findAvailability({
      tenantId: tenant.id, serviceId: services[0]!.id,
      from: THURSDAY, to: THURSDAY, now: at(THURSDAY, '00:01'),
    });

    const times = slotTimes(day!.slots);
    assert.equal(times[0], '09:00');
    assert.equal(times[times.length - 1], '16:00');
  });

  it('styttir framboð þegar starfsmaður vinnur hálfan dag', () => {
    const { tenant, services, staff } = salonFixture();
    setWeeklyHours(tenant.id, staff[0]!.id, {
      1: [[540, 1020]], 2: [[540, 1020]], 3: [[540, 1020]],
      4: [[540, 720]], 5: [[540, 1020]], 6: [], 7: [],
    });

    const [day] = findAvailability({
      tenantId: tenant.id, serviceId: services[0]!.id,
      from: THURSDAY, to: THURSDAY, now: at(THURSDAY, '00:01'),
    });

    assert.deepEqual(slotTimes(day!.slots), ['09:00', '09:30', '10:00', '10:30', '11:00']);
  });
});
