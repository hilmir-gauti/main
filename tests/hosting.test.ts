/**
 * External hosting: the shape of the request sent to Vercel, and what the
 * console does with what comes back.
 *
 * The request shape is worth pinning because it is unverifiable by reading —
 * a wrong `projectSettings` makes Vercel decide the site needs a build step,
 * and the failure surfaces minutes later as a build log rather than as an
 * error at the call site.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { setConfigOverrides } from '../src/config.ts';
import { deploySite, projectNameFor } from '../src/integrations/vercel/deploy.ts';
import { freshDatabase, salonFixture } from './helpers.ts';
import { publishVariant } from '../src/website/generator.ts';
import { deployPublishedSite, hostingStatus } from '../src/website/hosting.ts';

const realFetch = globalThis.fetch;

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** Replaces fetch with a recorder that answers like Vercel does. */
function stubVercel(responder: (captured: Captured) => { status?: number; body: unknown }): Captured[] {
  const calls: Captured[] = [];

  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const captured: Captured = {
      url: String(input),
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    };
    calls.push(captured);

    const reply = responder(captured);
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  return calls;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  setConfigOverrides({});
});

describe('nafngift Vercel-verkefna', () => {
  it('hreinsar slug og bætir við forskeyti', () => {
    setConfigOverrides({ VERCEL_PROJECT_PREFIX: 'rth' });
    assert.equal(projectNameFor('harstofan-osp'), 'rth-harstofan-osp');
  });

  it('fjarlægir stafi sem Vercel leyfir ekki', () => {
    setConfigOverrides({ VERCEL_PROJECT_PREFIX: 'rth' });
    // Slugs are already ASCII by the time they get here, but a hand-edited
    // domain field can still carry punctuation.
    assert.equal(projectNameFor('Bíla_Verk.stæðið!'), 'rth-b-la-verk-st-i');
  });

  it('endar aldrei á bandstriki, sem Vercel hafnar', () => {
    setConfigOverrides({ VERCEL_PROJECT_PREFIX: 'rth' });
    assert.equal(projectNameFor('---'), 'rth-vefur');
    assert.equal(projectNameFor('!!!'), 'rth-vefur');
  });

  it('heldur sér innan lengdarmarka Vercel', () => {
    setConfigOverrides({ VERCEL_PROJECT_PREFIX: 'rth' });
    const name = projectNameFor('a'.repeat(200));
    assert.ok(name.length <= 100);
    assert.doesNotMatch(name, /-$/);
  });
});

describe('sending á Vercel', () => {
  it('sendir skrár innfelldar, á framleiðslu, án byggingarþreps', async () => {
    setConfigOverrides({ VERCEL_TOKEN: 'lykill123' });

    const calls = stubVercel(() => ({
      body: { id: 'dpl_1', url: 'rth-stofan-abc.vercel.app', readyState: 'READY' },
    }));

    const result = await deploySite({
      slug: 'stofan',
      files: [{ file: 'index.html', data: '<h1>Hæ</h1>' }],
    });

    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.match(call.url, /\/v13\/deployments/);
    assert.equal(call.method, 'POST');
    assert.equal(call.headers.authorization, 'Bearer lykill123');
    assert.equal(call.body.target, 'production');
    assert.deepEqual(call.body.files, [{ file: 'index.html', data: '<h1>Hæ</h1>' }]);

    // A null framework is what keeps Vercel from guessing this is a Next.js app.
    const settings = call.body.projectSettings as Record<string, unknown>;
    assert.equal(settings.framework, null);
    assert.equal(settings.buildCommand, null);

    assert.equal(result.url, 'https://rth-stofan-abc.vercel.app');
    assert.equal(result.state, 'READY');
    assert.deepEqual(result.pendingDns, []);
  });

  it('sendir teymisauðkenni með þegar það er stillt', async () => {
    setConfigOverrides({ VERCEL_TOKEN: 'lykill123', VERCEL_TEAM_ID: 'team_abc' });
    const calls = stubVercel(() => ({ body: { id: 'dpl_1', url: 'x.vercel.app', readyState: 'READY' } }));

    await deploySite({ slug: 'stofan', files: [{ file: 'index.html', data: 'x' }] });
    assert.match(calls[0]!.url, /teamId=team_abc/);
  });

  it('skilar DNS-færslum þegar lén er óstaðfest', async () => {
    setConfigOverrides({ VERCEL_TOKEN: 'lykill123' });

    stubVercel((call) => {
      if (call.url.includes('/domains')) {
        return {
          body: {
            name: 'stofan.is',
            verified: false,
            verification: [{ type: 'TXT', domain: '_vercel.stofan.is', value: 'vc-domain-verify=abc' }],
          },
        };
      }
      return { body: { id: 'dpl_1', url: 'x.vercel.app', readyState: 'READY' } };
    });

    const result = await deploySite({
      slug: 'stofan',
      files: [{ file: 'index.html', data: 'x' }],
      domain: 'stofan.is',
    });

    assert.equal(result.domain, '');
    assert.deepEqual(result.pendingDns, ['TXT _vercel.stofan.is → vc-domain-verify=abc']);
  });

  it('gefur venjulegu A- og CNAME-færslurnar þegar Vercel nefnir enga áskorun', async () => {
    setConfigOverrides({ VERCEL_TOKEN: 'lykill123' });
    stubVercel((call) =>
      call.url.includes('/domains')
        ? { body: { name: 'stofan.is', verified: false } }
        : { body: { id: 'dpl_1', url: 'x.vercel.app', readyState: 'READY' } },
    );

    const result = await deploySite({ slug: 'stofan', files: [{ file: 'index.html', data: 'x' }], domain: 'stofan.is' });
    assert.match(result.pendingDns.join(' '), /76\.76\.21\.21/);
    assert.match(result.pendingDns.join(' '), /cname\.vercel-dns\.com/);
  });

  it('vitnar í villuboð Vercel svo þau séu fletjanleg upp', async () => {
    setConfigOverrides({ VERCEL_TOKEN: 'utrunninn' });
    stubVercel(() => ({ status: 403, body: { error: { code: 'forbidden', message: 'Not authorized' } } }));

    await assert.rejects(
      deploySite({ slug: 'stofan', files: [{ file: 'index.html', data: 'x' }] }),
      /forbidden: Not authorized/,
    );
  });

  it('neitar að senda þegar lykill vantar', async () => {
    setConfigOverrides({});
    await assert.rejects(
      deploySite({ slug: 'stofan', files: [{ file: 'index.html', data: 'x' }] }),
      /VERCEL_TOKEN/,
    );
  });
});

describe('hýsingarstaða viðskiptavinar', () => {
  it('sendir birtu útgáfuna og man hvar hún lenti', async () => {
    freshDatabase();
    const { tenant } = salonFixture();
    setConfigOverrides({ VERCEL_TOKEN: 'lykill123' });

    publishVariant(tenant.id, 'nutima');
    assert.equal(hostingStatus(tenant.id), null, 'ekkert sent enn');

    const calls = stubVercel(() => ({
      body: { id: 'dpl_9', url: 'rth-stofan.vercel.app', readyState: 'READY' },
    }));

    const result = await deployPublishedSite(tenant.id);
    assert.equal(result.version, 1);

    // All three generated files travel, not just the page.
    const sent = (calls[0]!.body.files as Array<{ file: string }>).map((f) => f.file);
    assert.deepEqual(sent.sort(), ['index.html', 'robots.txt', 'sitemap.xml']);

    const status = hostingStatus(tenant.id);
    assert.equal(status?.url, 'https://rth-stofan.vercel.app');
    assert.equal(status?.stale, false);
  });

  it('merkir hýsinguna úrelta þegar vefurinn er endurbirtur á eftir', async () => {
    freshDatabase();
    const { tenant } = salonFixture();
    setConfigOverrides({ VERCEL_TOKEN: 'lykill123' });

    publishVariant(tenant.id, 'nutima');
    stubVercel(() => ({ body: { id: 'dpl_9', url: 'x.vercel.app', readyState: 'READY' } }));
    await deployPublishedSite(tenant.id);

    // A new build supersedes the deployed one, and the console must say so
    // rather than keep claiming the live site is current.
    publishVariant(tenant.id, 'klassiskt');
    assert.equal(hostingStatus(tenant.id), null, 'ný útgáfa hefur ekki verið send');
  });

  it('neitar að senda þegar ekkert útlit hefur verið valið', async () => {
    freshDatabase();
    const { tenant } = salonFixture();
    setConfigOverrides({ VERCEL_TOKEN: 'lykill123' });

    await assert.rejects(deployPublishedSite(tenant.id), /Veldu útlit fyrst/);
  });
});
