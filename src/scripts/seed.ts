/**
 * Demo data.
 *
 * Creates three tenants that exercise the different scheduling models — a
 * staff-led salon, a resource-pool garage and a one-person plumber — with
 * bookings spread across the coming week so every screen has something to show.
 *
 *   npm run seed
 */

import { closeDatabase, openDatabase } from '../core/db.ts';
import { logger } from '../core/logger.ts';
import { addDays, hhmmToMinutes, instantFromWallClock, plainDateOf } from '../core/time.ts';
import { config } from '../config.ts';
import { createBooking } from '../domain/booking/bookings.ts';
import { listServices } from '../domain/catalog.ts';
import { industryPreset } from '../domain/industries.ts';
import { provisionTenant } from '../domain/provisioning.ts';
import { createTenant, getTenantBySlug, updateTenant } from '../domain/tenants.ts';
import { publishVariant } from '../website/generator.ts';
import type { Feature } from '../domain/types.ts';

const ALL_FEATURES: Feature[] = [
  'vefsida', 'bokanir', 'google_calendar', 'tolvupostur', 'simsvorun', 'sms', 'app_tilkynningar',
];

interface SeedSpec {
  name: string;
  industry: string;
  email: string;
  phone: string;
  address: string;
  postcode: string;
  domain: string;
  brandColor: string;
  staff?: string[];
  capacity?: number;
  variant: string;
}

const SEEDS: SeedSpec[] = [
  {
    name: 'Hárstofan Ösp',
    industry: 'hargreidslustofa',
    email: 'osp@example.is',
    phone: '5551234',
    address: 'Laugavegur 42',
    postcode: '101',
    domain: 'harstofanosp.is',
    brandColor: '#7c3aed',
    staff: ['Anna Jónsdóttir', 'Björk Ólafsdóttir'],
    variant: 'nutima',
  },
  {
    name: 'Bílaverkstæði Óla',
    industry: 'bilaverkstaedi',
    email: 'oli@example.is',
    phone: '5552345',
    address: 'Smiðjuvegur 4',
    postcode: '200',
    domain: 'bilaverkstaediola.is',
    brandColor: '#b45309',
    capacity: 3,
    variant: 'klassiskt',
  },
  {
    name: 'Pípulagnir Kára',
    industry: 'pipulagnir',
    email: 'kari@example.is',
    phone: '6663456',
    address: 'Hraunbær 12',
    postcode: '110',
    domain: 'pipulagnirkara.is',
    brandColor: '#0f766e',
    capacity: 1,
    variant: 'hlyleg',
  },
];

const CUSTOMERS = [
  { name: 'Guðrún Sigurðardóttir', phone: '6601111', email: 'gudrun@example.is' },
  { name: 'Einar Þórsson', phone: '6602222', email: 'einar@example.is' },
  { name: 'Sara Björnsdóttir', phone: '6603333', email: '' },
  { name: 'Magnús Helgason', phone: '6604444', email: 'magnus@example.is' },
  { name: 'Hildur Rúnarsdóttir', phone: '6605555', email: '' },
];

/** Intake answers per industry, so seeded bookings show realistic detail. */
function sampleIntake(industry: string, index: number): Record<string, string | string[]> {
  if (industry === 'bilaverkstaedi') {
    const variants: Array<Record<string, string | string[]>> = [
      { bilnumer: `AB${100 + index}`, bill_tegund: 'Toyota Yaris 2018', thjonusta: 'olia' },
      {
        bilnumer: `KX${200 + index}`, bill_tegund: 'Volkswagen Golf 2015', thjonusta: 'bremsur',
        bremsur_hvar: 'framan', bremsur_hvad: ['klossar', 'diskar'],
      },
      {
        bilnumer: `MN${300 + index}`, bill_tegund: 'Kia Sportage 2020', thjonusta: 'annad',
        veit_vandamal: 'nei',
        einkenni: ['titringur_styri', 'hljod_bremsur'],
        einkenni_hvenaer: ['bremsun', 'hradi'],
        hversu_lengi: 'vikur',
        akfaer: 'ja',
      },
    ];
    return variants[index % variants.length]!;
  }

  if (industry === 'hargreidslustofa') {
    const variants: Array<Record<string, string | string[]>> = [
      { thjonusta: 'klipping', har_sidd: 'medal', har_thykkt: 'medal', mynd_til: 'nei', utlit_lysing: 'Mýkri línur, meiri áferð í endum.' },
      { thjonusta: 'litun', har_sidd: 'sitt', har_thykkt: 'thykkt', litun_tegund: 'balayage', litad_adur: 'ja', nuverandi_litur: 'Ljóst með dökkri rót', heimalitun: 'nei', oskalitur: 'Öskuljóst', mynd_til: 'ja', mynd: 'https://example.com/mynd.jpg', ofnaemi: 'nei' },
    ];
    return variants[index % variants.length]!;
  }

  if (industry === 'pipulagnir') {
    return {
      bradatilfelli: 'nei',
      husnaedi: 'ibud',
      veit_vandamal: 'nei',
      einkenni: ['leki_krani', 'hagt_ad_renna'],
      hvar: ['badherbergi'],
      hversu_lengi: 'nokkrir_dagar',
      adgangur: 'eg_verd_heima',
      bilastaedi: 'ja',
    };
  }

  return {};
}

async function run(): Promise<void> {
  openDatabase();
  console.log('\n=== Set inn sýnigögn ===\n');

  let createdTenants = 0;
  let createdBookings = 0;

  for (const spec of SEEDS) {
    if (getTenantBySlug(spec.name.toLowerCase().replace(/[^a-z]/g, '-'))) {
      console.log(`· ${spec.name} er þegar til, sleppi.`);
      continue;
    }

    const preset = industryPreset(spec.industry);
    let tenant = createTenant({
      name: spec.name,
      industry: spec.industry,
      email: spec.email,
      phone: spec.phone,
      address: spec.address,
      postcode: spec.postcode,
      websiteDomain: spec.domain,
      brandColor: spec.brandColor,
    });

    provisionTenant({
      tenantId: tenant.id,
      features: ALL_FEATURES,
      staffNames: spec.staff ?? [],
      capacity: spec.capacity,
    });

    tenant = updateTenant(tenant.id, { status: 'virkur', minNoticeMin: 60 });
    publishVariant(tenant.id, spec.variant);
    createdTenants++;

    // --- Bookings across the coming week --------------------------------
    const services = listServices(tenant.id);
    const today = plainDateOf(Date.now(), tenant.timezone);
    const times = ['09:00', '10:30', '13:00', '14:30', '16:00'];

    for (let dayOffset = 0; dayOffset < 6; dayOffset++) {
      const date = addDays(today, dayOffset);

      for (let slot = 0; slot < 2; slot++) {
        const index = dayOffset * 2 + slot;
        const customer = CUSTOMERS[index % CUSTOMERS.length]!;
        const service = services[index % services.length]!;
        const time = times[index % times.length]!;
        const startsAt = instantFromWallClock(date, hhmmToMinutes(time), tenant.timezone);

        if (startsAt < Date.now() + 60 * 60_000) continue;

        try {
          createBooking({
            tenantId: tenant.id,
            serviceId: service.id,
            startsAt,
            source: index % 3 === 0 ? 'simi' : 'vefur',
            customer,
            intake: sampleIntake(spec.industry, index),
            notes: index % 4 === 0 ? 'Kem aðeins fyrr ef það er í lagi.' : '',
          });
          createdBookings++;
        } catch {
          // Slot taken, closed, or outside policy — expected while filling a week.
        }
      }
    }

    console.log(`· ${spec.name} — ${services.length} þjónustur, vefsíða birt (${spec.variant})`);
  }

  console.log(`\nTilbúið: ${createdTenants} viðskiptavinir, ${createdBookings} bókanir.`);
  console.log(`Opnaðu ${config.baseUrl}/stjornbord\n`);

  closeDatabase();
}

run().catch((error) => {
  logger.error('Sýnigögn mistókust', { error });
  process.exit(1);
});
