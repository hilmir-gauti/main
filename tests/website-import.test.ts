/**
 * Reading an existing website, and the brand colour that replaces the field
 * the operator used to fill in by hand.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { extractBrandColor, extractServices, parseSite } from '../src/website/import.ts';
import { brandColorForIndustry, resolveBrandColor } from '../src/website/palette-defaults.ts';

describe('einkennislitur af núverandi síðu', () => {
  it('trúir yfirlýstum theme-color umfram ágiskun', () => {
    const html = '<meta name="theme-color" content="#7C3AED"><style>a{color:#e11d48}a{color:#e11d48}</style>';
    assert.equal(extractBrandColor(html), '#7c3aed');
  });

  it('velur algengasta litaða tóninn þegar ekkert er yfirlýst', () => {
    const html = '<style>.a{color:#111827}.b{border:#e5e7eb}.c{background:#0d9488}.d{fill:#0d9488}</style>';
    assert.equal(extractBrandColor(html), '#0d9488');
  });

  it('hunsar gráa tóna, svarta og hvíta', () => {
    // A site whose "brand colour" comes out #333333 looks broken, and grey is
    // what body text and borders are made of.
    const html = '<style>body{color:#333333}hr{border:#cccccc}p{color:#1a1a1a}</style>';
    assert.equal(extractBrandColor(html), '');
  });

  it('hafnar stökum lit sem kemur aðeins einu sinni fyrir', () => {
    assert.equal(extractBrandColor('<style>.x{color:#ff5722}</style>'), '');
  });
});

describe('verðskrá lesin af síðu', () => {
  it('les nafn og verð á sömu línu', () => {
    const found = extractServices(['Klipping 8.900 kr.', 'Litun 24.500 kr.']);
    assert.deepEqual(found, [
      { name: 'Klipping', priceIsk: 8900 },
      { name: 'Litun', priceIsk: 24500 },
    ]);
  });

  it('les verð sem stendur á næstu línu', () => {
    assert.deepEqual(extractServices(['Handsnyrting', '12.500 kr.']), [
      { name: 'Handsnyrting', priceIsk: 12500 },
    ]);
  });

  it('tekur ekki ártöl eða símanúmer sem verð', () => {
    // 2019 is under the floor; a phone number carries no currency marker.
    assert.deepEqual(extractServices(['Stofnað 2019', 'Sími 555 1234']), []);
  });

  it('sleppir endurtekningum', () => {
    const found = extractServices(['Klipping 8.900 kr.', 'Klipping 8.900 kr.']);
    assert.equal(found.length, 1);
  });
});

describe('síða lesin í heild', () => {
  const page = `
    <html><head>
      <title>Hárstofan Ösp — hárgreiðsla í Reykjavík</title>
      <meta name="description" content="Persónuleg hárgreiðslustofa í hjarta Reykjavíkur.">
      <meta name="theme-color" content="#8b5cf6">
    </head><body>
      <nav><a href="/">Forsíða</a></nav>
      <p>Hárstofan Ösp hefur þjónustað Reykvíkinga frá árinu 2011. Við leggjum áherslu á persónulega
         þjónustu, vandaðar vörur og að hver viðskiptavinur fari ánægður út. Stofan er lítil og
         heimilisleg og við tökum á móti fólki á öllum aldri.</p>
      <p>Klipping 8.900 kr.</p>
      <p>Sími: 555 1234</p>
      <a href="mailto:osp@example.is">Netfang</a>
      <a href="https://facebook.com/harstofanosp?ref=nav">Facebook</a>
      <script>var tracking = "#123456";</script>
    </body></html>`;

  it('les titil, kjörorð, lýsingu, tengiliði og samfélagsmiðla', () => {
    const site = parseSite(page, 'https://osp.is/');
    assert.match(site.title, /Hárstofan Ösp/);
    assert.equal(site.tagline, 'Persónuleg hárgreiðslustofa í hjarta Reykjavíkur.');
    assert.match(site.about, /frá árinu 2011/);
    assert.equal(site.brandColor, '#8b5cf6');
    assert.equal(site.phone, '+3545551234');
    assert.equal(site.email, 'osp@example.is');
    assert.deepEqual(site.services, [{ name: 'Klipping', priceIsk: 8900 }]);
    // Tracking parameters are stripped so repeat imports do not accumulate.
    assert.deepEqual(site.socials, ['https://facebook.com/harstofanosp']);
  });

  it('les ekki texta úr script- eða nav-blokkum', () => {
    const site = parseSite(page, 'https://osp.is/');
    assert.doesNotMatch(site.about, /tracking|Forsíða/);
  });

  it('segir frá því sem fannst ekki, í stað þess að þegja', () => {
    const site = parseSite('<html><body><p>Stutt.</p></body></html>', 'https://x.is/');
    assert.match(site.notes.join(' '), /einkennislit/);
    assert.match(site.notes.join(' '), /verðskrá/);
  });
});

describe('einkennislitur án handvirks vals', () => {
  it('gefur hverju fagi sinn lit', () => {
    assert.notEqual(brandColorForIndustry('naglastofa'), brandColorForIndustry('pipulagnir'));
    assert.match(brandColorForIndustry('hargreidslustofa'), /^#[0-9a-f]{6}$/);
  });

  it('notar geymdan lit þegar hann er gildur, annars lit fagsins', () => {
    assert.equal(resolveBrandColor('#AABBCC', 'nudd'), '#aabbcc');
    assert.equal(resolveBrandColor('', 'nudd'), brandColorForIndustry('nudd'));
    assert.equal(resolveBrandColor('ekki-litur', 'nudd'), brandColorForIndustry('nudd'));
  });
});
