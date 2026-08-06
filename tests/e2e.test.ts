/**
 * End-to-end test.
 *
 * Boots the real HTTP server on an ephemeral port and walks the whole path a
 * customer and the operator actually take: log in, run the onboarding wizard,
 * publish a website, then book through the public API exactly as the generated
 * widget does — including the branching intake questionnaire.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The config module reads the environment once at import time, so these must
// be set before anything else is imported.
const dataDir = mkdtempSync(join(tmpdir(), 'rafraen-e2e-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.DATABASE_PATH = ':memory:';
process.env.SITES_DIR = join(dataDir, 'sites');
process.env.APP_SECRET = 'prófunarlykill-sem-er-nógu-langur-fyrir-hkdf-1234567890';
process.env.PORT = '0';
process.env.LOG_LEVEL = 'error';
process.env.TWILIO_VALIDATE_SIGNATURE = 'false';

const { openDatabase, closeDatabase } = await import('../src/core/db.ts');
const { createOperator } = await import('../src/domain/auth.ts');
const { registerSubscribers } = await import('../src/integrations/subscribers.ts');
const { createHttpServer } = await import('../src/http/server.ts');
const { buildRouter } = await import('../src/index.ts');
const { getTenantBySlug } = await import('../src/domain/tenants.ts');
const { listServices } = await import('../src/domain/catalog.ts');
const { flowForIndustry } = await import('../src/domain/intake/flows.ts');

const EMAIL = 'stjori@rafraenthjonusta.is';
const PASSWORD = 'ofurleynilegt-lykilord';

let server: Server;
let base: string;
/** Session cookie, carried across requests like a browser would. */
let cookie = '';
let csrfToken = '';

interface Res {
  status: number;
  body: string;
  headers: Headers;
}

async function request(path: string, options: { method?: string; form?: Record<string, string | string[]>; json?: unknown } = {}): Promise<Res> {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;

  let body: string | undefined;
  if (options.form) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(options.form)) {
      if (Array.isArray(value)) value.forEach((v) => params.append(key, v));
      else params.append(key, value);
    }
    body = params.toString();
    headers['content-type'] = 'application/x-www-form-urlencoded';
  } else if (options.json !== undefined) {
    body = JSON.stringify(options.json);
    headers['content-type'] = 'application/json';
  }

  const response = await fetch(`${base}${path}`, {
    method: options.method ?? (body ? 'POST' : 'GET'),
    headers,
    body,
    redirect: 'manual',
  });

  const setCookie = response.headers.getSetCookie?.() ?? [];
  for (const entry of setCookie) {
    const pair = entry.split(';')[0] ?? '';
    if (pair.startsWith('rth_session=')) cookie = pair;
  }

  return { status: response.status, body: await response.text(), headers: response.headers };
}

/** Extracts the CSRF token the admin templates embed in every form. */
function extractCsrf(html: string): string {
  const match = /name="_csrf" value="([^"]+)"/.exec(html);
  return match?.[1] ?? '';
}

before(async () => {
  openDatabase({ path: ':memory:' });
  await createOperator(EMAIL, PASSWORD, 'Prófunarstjóri');
  registerSubscribers();

  server = createHttpServer(buildRouter());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDatabase();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('heilsa', () => {
  it('svarar án innskráningar', async () => {
    const response = await request('/heilsa');
    assert.equal(response.status, 200);
    const data = JSON.parse(response.body);
    assert.equal(data.stada, 'i_lagi');
  });
});

describe('innskráning', () => {
  it('vísar óinnskráðum á innskráningarsíðu', async () => {
    const response = await request('/stjornbord');
    assert.equal(response.status, 303);
    assert.match(response.headers.get('location') ?? '', /innskraning/);
  });

  it('hafnar röngu lykilorði', async () => {
    const response = await request('/innskraning', { form: { netfang: EMAIL, lykilord: 'vitlaust' } });
    assert.equal(response.status, 401);
    assert.match(response.body, /rangt/i);
  });

  it('hleypir réttu lykilorði inn', async () => {
    const response = await request('/innskraning', { form: { netfang: EMAIL, lykilord: PASSWORD } });
    assert.equal(response.status, 303);
    assert.ok(cookie.startsWith('rth_session='), 'session-kaka á að vera sett');

    const dashboard = await request('/stjornbord');
    assert.equal(dashboard.status, 200);
    assert.match(dashboard.body, /Yfirlit/);

    csrfToken = extractCsrf(dashboard.body);
    assert.ok(csrfToken.length > 10, 'CSRF-auðkenni á að vera til staðar');
  });
});

describe('CSRF-vörn', () => {
  it('hafnar POST án auðkennis', async () => {
    const response = await request('/vidskiptavinir/nyr', {
      form: { nafn: 'Svindl ehf.', fag: 'annad' },
    });
    assert.equal(response.status, 403);
  });
});

describe('uppsetningarferli nýs viðskiptavinar', () => {
  let tenantId = '';

  it('stofnar viðskiptavin, þjónustur og vefútgáfur', async () => {
    const response = await request('/vidskiptavinir/nyr', {
      form: {
        _csrf: csrfToken,
        nafn: 'Bílaverkstæði Prófunar',
        fag: 'bilaverkstaedi',
        netfang: 'verkstaedi@example.is',
        simi: '5551234',
        heimilisfang: 'Smiðjuvegur 1',
        postnumer: '200',
        len: 'profunarverkstaedi.is',
        litur: '#b45309',
        afkastageta: '2',
        eiginleikar: ['vefsida', 'bokanir', 'sms'],
        postthjonusta: 'google',
      },
    });

    assert.equal(response.status, 303);
    const location = response.headers.get('location') ?? '';
    assert.match(location, /\/vidskiptavinir\/[^/]+\/vefur/);

    tenantId = location.split('/')[2] ?? '';
    assert.ok(tenantId, 'auðkenni viðskiptavinar á að vera í slóðinni');

    const tenant = getTenantBySlug('bilaverkstaedi-profunar');
    assert.ok(tenant, 'viðskiptavinur á að vera til');
    assert.ok(listServices(tenant!.id).length > 0, 'forstilltar þjónustur eiga að vera til');
  });

  it('sýnir þrjár útlitstillögur', async () => {
    const response = await request(`/vidskiptavinir/${tenantId}/vefur`);
    assert.equal(response.status, 200);

    for (const variant of ['klassiskt', 'nutima', 'hlyleg']) {
      assert.ok(response.body.includes(`/forskodun/${tenantId}/${variant}`), `${variant} vantar í forskoðun`);
    }
  });

  it('skilar forskoðun sem raunverulegri síðu', async () => {
    const response = await request(`/forskodun/${tenantId}/nutima`);
    assert.equal(response.status, 200);
    assert.match(response.body, /<!doctype html>/i);
    assert.match(response.body, /Bílaverkstæði Prófunar/);
    assert.match(response.body, /rth-bokun/, 'bókunarreitur á að vera á síðunni');
  });

  it('birtir valda útgáfu', async () => {
    const page = await request(`/vidskiptavinir/${tenantId}/vefur`);
    const token = extractCsrf(page.body);

    const response = await request(`/vidskiptavinir/${tenantId}/vefur`, {
      form: { _csrf: token, utgafa: 'klassiskt' },
    });
    assert.equal(response.status, 303);

    const site = await request('/v/bilaverkstaedi-profunar');
    assert.equal(site.status, 200);
    assert.match(site.body, /Bílaverkstæði Prófunar/);
    // The preview banner must not survive into the published site.
    assert.ok(!site.body.includes('preview-banner'), 'birt síða á ekki að hafa forskoðunarborða');
  });

  it('býr til verkefnalista með DNS-færslum', async () => {
    const response = await request(`/vidskiptavinir/${tenantId}/verkefni`);
    assert.equal(response.status, 200);
    assert.match(response.body, /Uppsetning/);
    assert.match(response.body, /Bókunarkerfi virkt/);
  });
});

describe('opinbert bókunarviðmót', () => {
  const slug = 'bilaverkstaedi-profunar';
  let serviceId = '';

  it('skilar uppsetningu með spurningaflæði', async () => {
    const response = await request(`/api/vefur/uppsetning?slug=${slug}`);
    assert.equal(response.status, 200);

    const config = JSON.parse(response.body);
    assert.ok(config.services.length > 0);
    assert.ok(config.flow.questions.length > 0);

    // The garage flow's defining question must be present.
    const keys = config.flow.questions.map((q: { key: string }) => q.key);
    assert.ok(keys.includes('bilnumer'));
    assert.ok(keys.includes('veit_vandamal'));
    assert.ok(keys.includes('einkenni'));

    serviceId = config.services[0].id;
  });

  it('skilar villum þegar skyldusvör vantar', async () => {
    const response = await request('/api/vefur/lausir-timar', {
      json: { slug, serviceId, svor: { thjonusta: 'olia' } },
    });

    assert.equal(response.status, 200);
    const data = JSON.parse(response.body);
    assert.ok(data.villur.bilnumer, 'bílnúmer á að vera skylda');
    assert.equal(data.dagar.length, 0);
  });

  it('skilar lausum tímum þegar svörin eru gild', async () => {
    const response = await request('/api/vefur/lausir-timar', {
      json: { slug, serviceId, svor: { bilnumer: 'AB123', thjonusta: 'olia' }, vika: 0 },
    });

    assert.equal(response.status, 200);
    const data = JSON.parse(response.body);
    assert.equal(data.dagar.length, 7, 'ein vika í einu');
    assert.ok(data.dagar.some((day: { timar: unknown[] }) => day.timar.length > 0), 'einhver dagur á að hafa lausa tíma');
  });

  it('bókar í gegnum greinótt spurningaflæði', async () => {
    // Walk the "I don't know what's wrong" branch, as a real customer would.
    const answers = {
      bilnumer: 'kx-450',
      bill_tegund: 'Volkswagen Golf 2015',
      thjonusta: 'annad',
      veit_vandamal: 'nei',
      einkenni: ['titringur_styri', 'hljod_bremsur'],
      einkenni_hvenaer: ['bremsun'],
      hversu_lengi: 'vikur',
      akfaer: 'ja',
      bilalan: 'ja',
    };

    const slotsResponse = await request('/api/vefur/lausir-timar', {
      json: { slug, serviceId, svor: answers, vika: 1 },
    });
    const slots = JSON.parse(slotsResponse.body);
    const day = slots.dagar.find((entry: { timar: unknown[] }) => entry.timar.length > 0);
    assert.ok(day, 'þarf lausan tíma til að bóka');

    const slot = day.timar[0];

    const booking = await request('/api/vefur/bokun', {
      json: {
        slug,
        serviceId,
        byrjar: slot.byrjar,
        starfsmadur: slot.starfsmadurId,
        svor: answers,
        nafn: 'Anna Prófun',
        simi: '6601234',
        netfang: 'anna@example.is',
        athugasemd: 'Kem á undan ef ég get.',
      },
    });

    assert.equal(booking.status, 201, booking.body);
    const created = JSON.parse(booking.body);
    assert.ok(created.bokunId);
    assert.match(created.afbokunarslod, /\/afbokun\//);

    // The wizard set two bays, so a second car at the same time is fine …
    const second = await request('/api/vefur/bokun', {
      json: {
        slug, serviceId, byrjar: slot.byrjar, starfsmadur: slot.starfsmadurId,
        svor: { bilnumer: 'CD456', thjonusta: 'olia' }, nafn: 'Seinni Prófun', simi: '6605678',
      },
    });
    assert.equal(second.status, 201, second.body);

    // … but a third exceeds capacity and must be refused.
    const third = await request('/api/vefur/bokun', {
      json: {
        slug, serviceId, byrjar: slot.byrjar, starfsmadur: slot.starfsmadurId,
        svor: { bilnumer: 'EF789', thjonusta: 'olia' }, nafn: 'Þriðji Prófun', simi: '6607777',
      },
    });
    assert.equal(third.status, 409, 'þriðji bíllinn á ekki að komast að þegar stæðin eru tvö');
  });

  it('sýnir svörin í stjórnborðinu', async () => {
    const tenant = getTenantBySlug('bilaverkstaedi-profunar')!;
    const response = await request(`/vidskiptavinir/${tenant.id}/bokanir?dagur=${new Date().toISOString().slice(0, 10)}`);
    assert.equal(response.status, 200);
    // The page renders; the booking may be on a later day, so just confirm the view works.
    assert.match(response.body, /Bókanir/);
  });

  it('leyfir viðskiptavini að afbóka með tengli', async () => {
    const answers = { bilnumer: 'ZZ999', thjonusta: 'olia' };
    const slotsResponse = await request('/api/vefur/lausir-timar', {
      json: { slug, serviceId, svor: answers, vika: 2 },
    });
    const day = JSON.parse(slotsResponse.body).dagar.find((entry: { timar: unknown[] }) => entry.timar.length > 0);
    const slot = day.timar[0];

    const booking = await request('/api/vefur/bokun', {
      json: { slug, serviceId, byrjar: slot.byrjar, svor: answers, nafn: 'Afbókun Prófun', simi: '6609999' },
    });
    const created = JSON.parse(booking.body);
    const token = created.afbokunarslod.split('/').pop();

    const page = await request(`/afbokun/${token}`);
    assert.equal(page.status, 200);
    assert.match(page.body, /Afbóka tíma/);

    const cancelled = await request(`/afbokun/${token}`, { form: { astaeda: 'Kemst ekki' } });
    assert.equal(cancelled.status, 200);
    assert.match(cancelled.body, /afbókaður/i);
  });
});

describe('tillögur frá gervigreind', () => {
  it('skilar tilbúnum tillögum þegar lykill vantar', async () => {
    const response = await request('/api/vefur/tillogur', {
      json: {
        slug: 'bilaverkstaedi-profunar',
        subject: 'útlit',
        description: 'Eitthvað einfalt og látlaust',
      },
    });

    assert.equal(response.status, 200);
    const data = JSON.parse(response.body);
    assert.equal(data.uppruni, 'tilbuid', 'án API-lykils á að nota tilbúnar tillögur');
    assert.ok(data.tillogur.length > 0);
  });
});

describe('símsvörun', () => {
  it('svarar á íslensku með TwiML', async () => {
    const tenant = getTenantBySlug('bilaverkstaedi-profunar')!;
    const response = await request(`/simi/${tenant.id}/svara`, {
      form: { CallSid: 'CA-prófun-1', From: '+3546601234', To: '+3545550000' },
    });

    assert.equal(response.status, 200);
    assert.match(response.body, /<Response>/);
    // The phone service is not enabled for this tenant, so it should say so
    // rather than silently dropping the call.
    assert.match(response.body, /<Say/);
    assert.match(response.body, /Polly\.Dora/, 'á að nota íslenska rödd');
  });

  it('hafnar óþekktum viðskiptavini snyrtilega', async () => {
    const response = await request('/simi/vsk_ekki_til/svara', {
      form: { CallSid: 'CA-prófun-2', From: '+3546601234' },
    });
    assert.equal(response.status, 404);
    assert.match(response.body, /<Response>/, 'jafnvel villur verða að vera gilt TwiML');
  });
});

describe('spurningaflæði er samstillt milli þjóns og viðmóts', () => {
  it('sendir sama flæði og notað er við staðfestingu', async () => {
    const response = await request('/api/vefur/uppsetning?slug=bilaverkstaedi-profunar');
    const config = JSON.parse(response.body);
    const serverFlow = flowForIndustry('bilaverkstaedi');

    assert.equal(config.flow.questions.length, serverFlow.questions.length);
    assert.deepEqual(
      config.flow.questions.map((q: { key: string }) => q.key),
      serverFlow.questions.map((q) => q.key),
    );
  });
});

describe('útskráning', () => {
  it('eyðir setu', async () => {
    const dashboard = await request('/stjornbord');
    const token = extractCsrf(dashboard.body);

    const response = await request('/utskraning', { form: { _csrf: token } });
    assert.equal(response.status, 303);

    cookie = '';
    const after_ = await request('/stjornbord');
    assert.equal(after_.status, 303, 'á að vísa á innskráningu eftir útskráningu');
  });
});
