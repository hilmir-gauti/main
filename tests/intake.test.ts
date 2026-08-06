/**
 * Intake questionnaire tests.
 *
 * The branching is the whole point, so these walk the actual paths a customer
 * takes — including the garage's "I don't know what's wrong" tree, which is
 * the deepest one in the system.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { flowForIndustry, flowSummary } from '../src/domain/intake/flows.ts';
import {
  evaluateCondition,
  isValidPlate,
  normalizePlate,
  renderAnswers,
  estimatedExtraMinutes,
  suggestedServiceName,
  validateIntake,
  visibleQuestions,
} from '../src/domain/intake/schema.ts';
import { prepareIntake, bookingAnswerSummary } from '../src/domain/intake/service.ts';
import { createBooking } from '../src/domain/booking/bookings.ts';
import { createService } from '../src/domain/catalog.ts';
import { setWeeklyHours } from '../src/domain/schedule.ts';
import { createTenant, updateTenant } from '../src/domain/tenants.ts';
import { at, freshDatabase } from './helpers.ts';

const THURSDAY = '2026-08-06';

describe('skilyrði (condition evaluation)', () => {
  it('metur equals, oneOf og answered', () => {
    const answers = { thjonusta: 'annad', einkenni: ['titringur_styri', 'hljod_hjol'] };

    assert.equal(evaluateCondition({ key: 'thjonusta', equals: 'annad' }, answers), true);
    assert.equal(evaluateCondition({ key: 'thjonusta', equals: 'olia' }, answers), false);
    assert.equal(evaluateCondition({ key: 'einkenni', oneOf: ['hljod_hjol'] }, answers), true);
    assert.equal(evaluateCondition({ key: 'einkenni', oneOf: ['leki'] }, answers), false);
    assert.equal(evaluateCondition({ key: 'einkenni', answered: true }, answers), true);
    assert.equal(evaluateCondition({ key: 'bilnumer', answered: true }, answers), false);
  });

  it('metur all og any', () => {
    const answers = { thjonusta: 'annad', veit_vandamal: 'nei' };

    assert.equal(
      evaluateCondition({ all: [{ key: 'thjonusta', equals: 'annad' }, { key: 'veit_vandamal', equals: 'nei' }] }, answers),
      true,
    );
    assert.equal(
      evaluateCondition({ all: [{ key: 'thjonusta', equals: 'annad' }, { key: 'veit_vandamal', equals: 'ja' }] }, answers),
      false,
    );
    assert.equal(
      evaluateCondition({ any: [{ key: 'veit_vandamal', equals: 'ja' }, { key: 'thjonusta', equals: 'annad' }] }, answers),
      true,
    );
  });

  it('sýnir spurningu án skilyrðis alltaf', () => {
    assert.equal(evaluateCondition(undefined, {}), true);
  });
});

describe('bílaverkstæði — greinar í spurningaflæði', () => {
  const flow = flowForIndustry('bilaverkstaedi');

  it('spyr um bremsur þegar bremsuskipti eru valin', () => {
    const visible = visibleQuestions(flow, { thjonusta: 'bremsur' }).map((q) => q.key);

    assert.ok(visible.includes('bremsur_hvar'));
    assert.ok(visible.includes('bremsur_hvad'));
    assert.ok(!visible.includes('veit_vandamal'), 'á ekki að spyrja um vandamál');
    assert.ok(!visible.includes('einkenni'));
  });

  it('spyr „veistu hvað er að?“ þegar Annað er valið', () => {
    const visible = visibleQuestions(flow, { thjonusta: 'annad' }).map((q) => q.key);
    assert.ok(visible.includes('veit_vandamal'));
    assert.ok(!visible.includes('vandamal_lysing'), 'lýsing kemur ekki fyrr en svarað er já');
    assert.ok(!visible.includes('einkenni'));
  });

  it('biður um lýsingu þegar viðskiptavinur veit hvað er að', () => {
    const visible = visibleQuestions(flow, { thjonusta: 'annad', veit_vandamal: 'ja' }).map((q) => q.key);
    assert.ok(visible.includes('vandamal_lysing'));
    assert.ok(!visible.includes('einkenni'), 'einkennalistinn á ekki að birtast');
  });

  it('býður einkennalista þegar viðskiptavinur veit ekki hvað er að', () => {
    const visible = visibleQuestions(flow, { thjonusta: 'annad', veit_vandamal: 'nei' }).map((q) => q.key);
    assert.ok(visible.includes('einkenni'));
    assert.ok(!visible.includes('vandamal_lysing'));

    const symptoms = flow.questions.find((q) => q.key === 'einkenni')!;
    const values = (symptoms.options ?? []).map((o) => o.value);
    // The symptom vocabulary the customer was promised.
    assert.ok(values.includes('titringur_styri'));
    assert.ok(values.includes('hljod_innan'));
    assert.ok(values.includes('hljod_vel'));
    assert.ok(values.includes('hljod_hjol'));
  });

  it('spyr nánar út í viðvörunarljós þegar þau eru valin', () => {
    const answers = { thjonusta: 'annad', veit_vandamal: 'nei', einkenni: ['vidvorunarljos'] };
    const visible = visibleQuestions(flow, answers).map((q) => q.key);

    assert.ok(visible.includes('vidvorunarljos_hvada'));
    assert.ok(visible.includes('einkenni_hvenaer'));
  });

  it('krefst lýsingar þegar „Annað“ einkenni er valið', () => {
    const answers = { thjonusta: 'annad', veit_vandamal: 'nei', einkenni: ['annad_einkenni'] };
    const result = validateIntake(flow, answers);

    assert.equal(result.valid, false);
    assert.ok(result.errors.einkenni_annad_lysing);
  });
});

describe('staðfesting svara', () => {
  const flow = flowForIndustry('bilaverkstaedi');

  it('krefst bílnúmers', () => {
    const result = validateIntake(flow, { thjonusta: 'olia' });
    assert.equal(result.valid, false);
    assert.ok(result.errors.bilnumer);
  });

  it('samþykkir og staðlar bílnúmer', () => {
    const result = validateIntake(flow, { bilnumer: 'ab-123', thjonusta: 'olia' });
    assert.equal(result.valid, true);
    assert.equal(result.cleaned.bilnumer, 'AB123');
  });

  it('hafnar ógildu bílnúmeri', () => {
    const result = validateIntake(flow, { bilnumer: 'x', thjonusta: 'olia' });
    assert.equal(result.valid, false);
    assert.ok(result.errors.bilnumer);
  });

  it('hendir svörum við földum spurningum', () => {
    // Customer picked "Other", typed an explanation, then switched to oil change.
    const result = validateIntake(flow, {
      bilnumer: 'AB123',
      thjonusta: 'olia',
      veit_vandamal: 'ja',
      vandamal_lysing: 'gamalt svar sem á ekki lengur við',
    });

    assert.equal(result.valid, true);
    assert.equal(result.cleaned.vandamal_lysing, undefined, 'falið svar á ekki að geymast');
    assert.equal(result.cleaned.veit_vandamal, undefined);
  });

  it('hafnar valkosti sem er ekki í listanum', () => {
    const result = validateIntake(flow, { bilnumer: 'AB123', thjonusta: 'eitthvad_rugl' });
    assert.equal(result.valid, false);
    assert.ok(result.errors.thjonusta);
  });

  it('staðfestir myndaslóð', () => {
    const nails = flowForIndustry('naglastofa');
    const bad = validateIntake(nails, { thjonusta: 'gelalakk', mynd_til: 'ja', mynd: 'javascript:alert(1)', ofnaemi: 'nei' });
    assert.equal(bad.valid, false);
    assert.ok(bad.errors.mynd);

    const good = validateIntake(nails, {
      thjonusta: 'gelalakk', mynd_til: 'ja', mynd: 'https://instagram.com/p/abc', ofnaemi: 'nei',
    });
    assert.equal(good.valid, true);
  });
});

describe('bílnúmer', () => {
  it('staðlar snið', () => {
    assert.equal(normalizePlate('ab 123'), 'AB123');
    assert.equal(normalizePlate('ab-123'), 'AB123');
    assert.equal(normalizePlate('Óð123'), 'ÓÐ123');
  });

  it('metur gildi', () => {
    assert.equal(isValidPlate('AB123'), true);
    assert.equal(isValidPlate('MITT'), true, 'einkanúmer eru leyfð');
    assert.equal(isValidPlate('A'), false);
    assert.equal(isValidPlate(''), false);
  });
});

describe('tímalengd og þjónustuval út frá svörum', () => {
  it('leggur saman aukamínútur', () => {
    const flow = flowForIndustry('hargreidslustofa');
    const extra = estimatedExtraMinutes(flow, {
      thjonusta: 'litun',
      har_sidd: 'mjog_sitt',   // +40
      har_thykkt: 'thykkt',    // +15
      litun_tegund: 'balayage', // +45
      litad_adur: 'nei',
    });
    assert.equal(extra, 100);
  });

  it('telur ekki aukamínútur úr földum greinum', () => {
    const flow = flowForIndustry('bilaverkstaedi');
    const extra = estimatedExtraMinutes(flow, {
      bilnumer: 'AB123',
      thjonusta: 'olia',
      bremsur_hvar: 'badir', // hidden — service is not brakes
    });
    assert.equal(extra, 0);
  });

  it('finnur þjónustu út frá svari', () => {
    const flow = flowForIndustry('bilaverkstaedi');
    assert.equal(suggestedServiceName(flow, { bilnumer: 'AB123', thjonusta: 'bremsur' }), 'Bremsuviðgerð');
    assert.equal(suggestedServiceName(flow, { bilnumer: 'AB123', thjonusta: 'olia' }), 'Smurþjónusta');
  });
});

describe('framsetning svara fyrir starfsmann', () => {
  it('birtir merkimiða í stað lykla', () => {
    const flow = flowForIndustry('bilaverkstaedi');
    const rendered = renderAnswers(flow, {
      bilnumer: 'AB123',
      thjonusta: 'annad',
      veit_vandamal: 'nei',
      einkenni: ['titringur_styri', 'hljod_bremsur'],
    });

    const map = new Map(rendered.map((entry) => [entry.label, entry.value]));
    assert.equal(map.get('Bílnúmer'), 'AB123');
    assert.equal(map.get('Hvaða þjónustu þarftu?'), 'Annað');
    assert.equal(map.get('Veistu hvað er að?'), 'Nei');
    assert.equal(map.get('Hvaða einkenni tekurðu eftir?'), 'Titringur — í stýri, Ískur eða urg þegar ég bremsa');
  });
});

describe('samþætting við bókun', () => {
  beforeEach(freshDatabase);

  function garage() {
    let tenant = createTenant({ name: 'Verkstæðið', industry: 'bilaverkstaedi' });
    tenant = updateTenant(tenant.id, { minNoticeMin: 0, slotGranularityMin: 30, respectHolidays: false, maxAdvanceDays: 365 });
    setWeeklyHours(tenant.id, null, {
      1: [[540, 1020]], 2: [[540, 1020]], 3: [[540, 1020]], 4: [[540, 1020]], 5: [[540, 1020]], 6: [], 7: [],
    });
    const service = createService(tenant.id, {
      name: 'Bremsuviðgerð', durationMin: 60, priceIsk: 54900, requiresStaff: false, capacity: 2,
    });
    return { tenant, service };
  }

  it('vistar svör með bókun og skilar þeim aftur', () => {
    const { tenant, service } = garage();
    const now = at(THURSDAY, '08:00');

    const booking = createBooking({
      tenantId: tenant.id,
      serviceId: service.id,
      startsAt: at(THURSDAY, '10:00'),
      customer: { name: 'Jón Jónsson', phone: '5551234' },
      now,
      intake: {
        bilnumer: 'ab123',
        bill_tegund: 'Toyota Yaris 2018',
        thjonusta: 'bremsur',
        bremsur_hvar: 'framan',
        bremsur_hvad: ['klossar', 'diskar'],
      },
    });

    const summary = new Map(bookingAnswerSummary(booking.id).map((entry) => [entry.label, entry.value]));
    assert.equal(summary.get('Bílnúmer'), 'AB123');
    assert.equal(summary.get('Hvaða þjónustu þarftu?'), 'Bremsuskipti (diskar/klossar)');
    assert.equal(summary.get('Hvað á að endurnýja?'), 'Bremsuklossar, Bremsudiskar');
  });

  it('hafnar bókun þegar skyldusvar vantar', () => {
    const { tenant, service } = garage();

    assert.throws(
      () =>
        createBooking({
          tenantId: tenant.id,
          serviceId: service.id,
          startsAt: at(THURSDAY, '10:00'),
          customer: { name: 'Jón', phone: '5551234' },
          now: at(THURSDAY, '08:00'),
          intake: { thjonusta: 'olia' }, // bílnúmer vantar
        }),
      /vantar|rangar|Ógild/i,
    );
  });

  it('lengir bókun þegar svörin kalla á lengri tíma', () => {
    const { tenant, service } = garage();
    const now = at(THURSDAY, '08:00');

    const booking = createBooking({
      tenantId: tenant.id,
      serviceId: service.id,
      startsAt: at(THURSDAY, '10:00'),
      customer: { name: 'Jón', phone: '5551234' },
      now,
      intake: {
        bilnumer: 'AB123',
        thjonusta: 'bremsur',
        bremsur_hvar: 'badir',       // +90 mín
        bremsur_hvad: ['diskar'],    // +30 mín
      },
    });

    // 60 mín grunnur + 120 mín aukalega = 180 mín.
    assert.equal(booking.endsAt - booking.startsAt, 180 * 60_000);
  });

  it('finnur rétta þjónustu út frá svörum', () => {
    const { tenant } = garage();
    // bremsur_hvar is required once the brakes branch opens.
    const incomplete = prepareIntake(tenant.id, { bilnumer: 'AB123', thjonusta: 'bremsur' });
    assert.equal(incomplete.valid, false);
    assert.ok(incomplete.errors.bremsur_hvar);

    const prepared = prepareIntake(tenant.id, {
      bilnumer: 'AB123',
      thjonusta: 'bremsur',
      bremsur_hvar: 'framan',
    });

    assert.equal(prepared.valid, true);
    assert.equal(prepared.service?.name, 'Bremsuviðgerð');
  });
});

describe('öll fög hafa nothæft flæði', () => {
  const industries = [
    'bilaverkstaedi', 'dekkjaverkstaedi', 'hargreidslustofa', 'naglastofa',
    'snyrtistofa', 'pipulagnir', 'rafvirki', 'sjukrathjalfun', 'nudd', 'annad',
  ];

  for (const industry of industries) {
    it(`${industry} hefur spurningar og gildar tilvísanir`, () => {
      const flow = flowForIndustry(industry);
      assert.equal(flow.industry, industry);
      assert.ok(flow.questions.length >= 3, 'flæði þarf að hafa efni');

      const keys = new Set(flow.questions.map((q) => q.key));
      assert.equal(keys.size, flow.questions.length, 'lyklar mega ekki endurtaka sig');

      // Every condition must reference a question that exists, or the branch
      // can never be shown.
      const referenced = (condition: unknown): string[] => {
        if (!condition || typeof condition !== 'object') return [];
        const c = condition as Record<string, unknown>;
        if (Array.isArray(c.all)) return c.all.flatMap(referenced);
        if (Array.isArray(c.any)) return c.any.flatMap(referenced);
        return typeof c.key === 'string' ? [c.key] : [];
      };

      for (const question of flow.questions) {
        for (const key of referenced(question.showIf)) {
          assert.ok(keys.has(key), `${industry}: ${question.key} vísar í óþekktan lykil ${key}`);
        }
        if (question.type === 'val' || question.type === 'fjolval') {
          assert.ok((question.options ?? []).length > 0, `${industry}: ${question.key} vantar valkosti`);
        }
      }

      const summary = flowSummary(industry);
      assert.equal(summary.total, flow.questions.length);
    });
  }
});
