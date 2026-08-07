/**
 * Company lookup by kennitala.
 *
 * The parsers run against fragments of the real pages, saved under
 * `tests/fixtures/`. Hand-written HTML would only prove the parser matches
 * what I imagined the registry looks like, which is the thing most likely to
 * be wrong.
 *
 * The other half of these tests is the safety property: contact details are
 * only ever adopted from a domain whose registrant is demonstrably this
 * company, and no field is ever filled by guessing.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseRegistryPage } from '../src/integrations/registry/fyrirtaekjaskra.ts';
import { domainCandidates, parseWhoisPage, registrantMatches } from '../src/integrations/registry/isnic.ts';
import { industryFromIsat } from '../src/domain/lookup.ts';

const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');

describe('fyrirtækjaskrá — þáttun', () => {
  it('les nafn, heimilisfang, rekstrarform og ÍSAT úr raunverulegri síðu', () => {
    const company = parseRegistryPage(fixture('fyrirtaekjaskra.html'), '4710080280');
    assert.ok(company);
    assert.equal(company.name, 'Landsbankinn hf.');
    assert.equal(company.address, 'Reykjastræti 6');
    assert.equal(company.postcode, '101');
    assert.equal(company.city, 'Reykjavík');
    assert.equal(company.legalForm, 'Hlutafélag, almennt (hf)');
    assert.equal(company.isatCode, '64.19.0');
    assert.equal(company.vskNumber, '109107');
  });

  it('skilar engu þegar kennitalan er ekki á síðunni', () => {
    // A mismatched page means the registry returned something else entirely.
    // Half a record is worse than none: the wizard would fill in another
    // company's address.
    assert.equal(parseRegistryPage(fixture('fyrirtaekjaskra.html'), '1234567890'), null);
  });

  it('skilar engu fyrir tóma síðu', () => {
    assert.equal(parseRegistryPage('<html><body></body></html>', '4710080280'), null);
  });
});

describe('lénaskrá — þáttun', () => {
  it('les eiganda, netfang og síma úr raunverulegri whois-síðu', () => {
    const record = parseWhoisPage(fixture('isnic.html'), 'skatturinn.is');
    assert.ok(record);
    assert.equal(record.registrantName, 'Skatturinn');
    assert.equal(record.email, 'velbunadur@skatturinn.is');
    assert.equal(record.phone, '+354 442 1000');
    assert.equal(record.postcode, '105');
  });

  it('skilar engu fyrir laust lén', () => {
    const page = '<div>The domain stofan.is is available</div><div>Register stofan.is</div>';
    assert.equal(parseWhoisPage(page, 'stofan.is'), null);
  });
});

describe('lén giskað út frá nafni', () => {
  it('sleppir rekstrarformi og býr til fá, markviss tilbrigði', () => {
    assert.deepEqual(domainCandidates('Hárgreiðslustofan Ösp ehf.'), [
      'hargreidslustofanosp.is', 'hargreidslustofan-osp.is', 'osp.is',
    ]);
    assert.deepEqual(domainCandidates('Icelandair ehf.'), ['icelandair.is']);
  });

  it('flettir aldrei upp fleiri en þremur lénum', () => {
    // Each candidate is one request to ISNIC. This is an onboarding
    // convenience, not a sweep of the registry.
    assert.ok(domainCandidates('Eitt Tvö Þrjú Fjögur Fimm Sex ehf.').length <= 3);
  });
});

describe('eigandi léns verður að vera fyrirtækið', () => {
  it('samþykkir styttra heiti og fullt lögheiti', () => {
    assert.equal(registrantMatches('Hárgreiðslustofan Ösp ehf.', 'Ösp'), true);
    assert.equal(registrantMatches('Hárgreiðslustofan Ösp ehf.', 'Hárgreiðslustofan Ösp ehf.'), true);
    assert.equal(registrantMatches('Icelandair ehf.', 'Icelandair Group hf.'), true);
  });

  it('hafnar svipuðum en ólíkum nöfnum', () => {
    // This is the whole point of the check: osp.is may belong to someone with
    // no connection to the salon, and their phone number must not end up on
    // the salon's website.
    assert.equal(registrantMatches('Hárgreiðslustofan Ösp ehf.', 'Óspar ehf.'), false);
    assert.equal(registrantMatches('Hárgreiðslustofan Ösp ehf.', 'Jón Jónsson'), false);
    assert.equal(registrantMatches('Stofan ehf.', ''), false);
  });
});

describe('ÍSAT-vörpun á fag', () => {
  it('notar textann þegar hann er nákvæmari en kóðinn', () => {
    // 96.02 covers hair, beauty and nails alike; the label distinguishes them.
    assert.equal(industryFromIsat('96.02.1', 'Hárgreiðslustofur'), 'hargreidslustofa');
    assert.equal(industryFromIsat('96.02.2', 'Snyrtistofur'), 'snyrtistofa');
    assert.equal(industryFromIsat('96.02.2', 'Naglasnyrting'), 'naglastofa');
  });

  it('varpar iðngreinum eftir kóða', () => {
    assert.equal(industryFromIsat('43.22.0', ''), 'pipulagnir');
    assert.equal(industryFromIsat('43.21.0', ''), 'rafvirki');
    assert.equal(industryFromIsat('45.20.1', ''), 'bilaverkstaedi');
  });

  it('fellur á „annað“ frekar en að giska', () => {
    assert.equal(industryFromIsat('64.19.0', 'Önnur fjármálafyrirtæki'), 'annad');
    assert.equal(industryFromIsat('', ''), 'annad');
  });
});
