/**
 * The webstore: pricing, stock and what ends up in the generated page.
 *
 * Two things here are worth pinning down with tests rather than by reading.
 *
 * **Pricing is server-side.** The basket that arrives from a browser is a list
 * of wishes; if a tampered price or a stale one could ever reach an order
 * total, the shop is broken in a way nobody would notice until the invoice.
 *
 * **Stock is a race.** Two people buying the last one-off board is the whole
 * reason the stock column exists, so the reservation is tested by actually
 * running the second order and expecting it to fail.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { ValidationError } from '../src/core/errors.ts';
import { splitVsk } from '../src/core/iceland.ts';
import { industryPreset } from '../src/domain/industries.ts';
import { provisionTenant } from '../src/domain/provisioning.ts';
import {
  createProduct,
  getProductOrThrow,
  isAvailable,
  listCategories,
  listProducts,
  updateProduct,
} from '../src/domain/shop/products.ts';
import {
  createOrder,
  getOrderByToken,
  listOrders,
  orderStats,
  priceCart,
  setOrderStatus,
  shippingFor,
  shopSettings,
} from '../src/domain/shop/orders.ts';
import { createTenant, setFeature } from '../src/domain/tenants.ts';
import { DEFAULT_SHOP_SETTINGS, type Tenant } from '../src/domain/types.ts';
import { renderSite, loadSiteContent, shopConfig } from '../src/website/generator.ts';
import { freshDatabase } from './helpers.ts';

/** A joinery with the webstore switched on and nothing on the shelf yet. */
function workshop(): Tenant {
  const tenant = createTenant({ name: 'Smiðjan Prófun', industry: 'tresmidi', email: 'smidjan@example.is' });
  setFeature(tenant.id, 'vefverslun', true);
  setFeature(tenant.id, 'vefsida', true);
  return tenant;
}

const CUSTOMER = { name: 'Guðrún Sigurðardóttir', phone: '6601111', email: 'gudrun@example.is' };

describe('vörulisti', () => {
  beforeEach(freshDatabase);

  it('gefur vörum einkvæma slóð innan verslunar', () => {
    const tenant = workshop();
    const first = createProduct(tenant.id, { name: 'Skurðarbretti', priceIsk: 40000 });
    const second = createProduct(tenant.id, { name: 'Skurðarbretti', priceIsk: 46000 });

    assert.equal(first.slug, 'skurdarbretti');
    assert.equal(second.slug, 'skurdarbretti-2', 'annað eintak af sama heiti fær viðskeyti');
  });

  it('telur ekki birgðir á vörum sem eru smíðaðar eftir pöntun', () => {
    const tenant = workshop();
    const madeToOrder = createProduct(tenant.id, {
      name: 'Sófaborð', priceIsk: 250000, madeToOrder: true, leadTimeDays: 45, stock: 7,
    });

    assert.equal(madeToOrder.stock, 0, 'pöntunarvara á ekkert hillupláss');
    assert.ok(isAvailable(madeToOrder), 'og selst aldrei upp');
  });

  it('felur uppseldar lagervörur fyrir körfunni en ekki fyrir síðunni', () => {
    const tenant = workshop();
    createProduct(tenant.id, { name: 'Handklæðastandur', priceIsk: 27900, stock: 0 });

    assert.equal(listProducts(tenant.id, { publicOnly: true }).length, 1, 'uppselt stendur áfram á síðunni');
    assert.equal(listProducts(tenant.id, { publicOnly: true, availableOnly: true }).length, 0);
  });

  it('hafnar myndaslóð sem er ekki http(s)', () => {
    const tenant = workshop();
    assert.throws(
      () => createProduct(tenant.id, { name: 'Taflborð', priceIsk: 54000, imageUrl: 'javascript:alert(1)' }),
      (error: unknown) => error instanceof ValidationError && 'imageUrl' in error.fieldErrors,
    );

    // Sama sía gildir við uppfærslu, þar sem gildið endar beint í markup-inu.
    const product = createProduct(tenant.id, { name: 'Taflborð', priceIsk: 54000 });
    assert.equal(updateProduct(product.id, { imageUrl: 'data:text/html,<script>' }).imageUrl, '');
  });

  it('skilar flokkum í röð vörulistans', () => {
    const tenant = workshop();
    createProduct(tenant.id, { name: 'Bretti', priceIsk: 1000, category: 'Skurðarbretti' });
    createProduct(tenant.id, { name: 'Bakki', priceIsk: 2000, category: 'Framreiðsla' });
    createProduct(tenant.id, { name: 'Bretti 2', priceIsk: 3000, category: 'Skurðarbretti' });

    assert.deepEqual(listCategories(tenant.id), ['Skurðarbretti', 'Framreiðsla']);
  });
});

describe('verðútreikningur körfu', () => {
  beforeEach(freshDatabase);

  it('reiknar verð úr vörulistanum, ekki úr körfunni', () => {
    const tenant = workshop();
    const product = createProduct(tenant.id, { name: 'Bretti', priceIsk: 40000, stock: 5 });

    const cart = priceCart(tenant.id, [{ productId: product.id, quantity: 2 }], 'saekja');

    assert.equal(cart.itemsIsk, 80000);
    assert.equal(cart.shippingIsk, 0, 'sótt kostar ekkert');
    assert.equal(cart.totalIsk, 80000);
    assert.equal(cart.vskIsk, splitVsk(80000).vsk);
  });

  it('leggur sendingarkostnað á, og fellir hann niður yfir mörkunum', () => {
    const tenant = workshop();
    setFeature(tenant.id, 'vefverslun', true, { shippingIsk: 1890, freeShippingOverIsk: 30000 });
    const cheap = createProduct(tenant.id, { name: 'Standur', priceIsk: 10000, stock: 5 });
    const dear = createProduct(tenant.id, { name: 'Borð', priceIsk: 250000, madeToOrder: true });

    assert.equal(priceCart(tenant.id, [{ productId: cheap.id, quantity: 1 }], 'sending').shippingIsk, 1890);
    assert.equal(priceCart(tenant.id, [{ productId: dear.id, quantity: 1 }], 'sending').shippingIsk, 0);
  });

  it('hafnar vöru úr annarri verslun', () => {
    const mine = workshop();
    const theirs = createTenant({ name: 'Önnur smiðja', industry: 'tresmidi' });
    setFeature(theirs.id, 'vefverslun', true);
    const product = createProduct(theirs.id, { name: 'Bretti', priceIsk: 40000, stock: 1 });

    assert.throws(() => priceCart(mine.id, [{ productId: product.id, quantity: 1 }], 'saekja'), /verslun/i);
  });

  it('hafnar meiri fjölda en er til', () => {
    const tenant = workshop();
    const product = createProduct(tenant.id, { name: 'Bretti', priceIsk: 40000, stock: 2 });

    assert.throws(() => priceCart(tenant.id, [{ productId: product.id, quantity: 3 }], 'saekja'), /2 eintök/);
  });

  it('gefur fría sendingu og sókn sama verð þegar sótt er', () => {
    const settings = { ...DEFAULT_SHOP_SETTINGS, shippingIsk: 2500, freeShippingOverIsk: 0 };
    assert.equal(shippingFor(settings, 5000, 'saekja'), 0);
    assert.equal(shippingFor(settings, 5000, 'sending'), 2500);
    // Núll þýðir að reglan er slökkt, ekki að allt sé frítt.
    assert.equal(shippingFor(settings, 9_000_000, 'sending'), 2500);
  });
});

describe('pantanir', () => {
  beforeEach(freshDatabase);

  it('skráir pöntun, tekur frá birgðir og gefur tilvísun', () => {
    const tenant = workshop();
    const product = createProduct(tenant.id, { name: 'Bretti', priceIsk: 40000, stock: 3 });

    const order = createOrder({
      tenantId: tenant.id,
      lines: [{ productId: product.id, quantity: 2 }],
      delivery: 'saekja',
      customer: CUSTOMER,
    });

    assert.match(order.reference, /^P-[0-9A-Z]{5}$/);
    assert.equal(order.status, 'ny');
    assert.equal(order.totalIsk, 80000);
    assert.equal(order.items.length, 1);
    assert.equal(order.items[0]?.lineTotalIsk, 80000);
    assert.equal(getProductOrThrow(product.id).stock, 1, 'tvö eintök tekin frá');
    assert.equal(getOrderByToken(order.statusToken)?.id, order.id);
  });

  it('lætur seinni kaupandann að síðasta eintakinu fá villu', () => {
    const tenant = workshop();
    const product = createProduct(tenant.id, { name: 'Einstakt bretti', priceIsk: 40000, stock: 1 });

    createOrder({ tenantId: tenant.id, lines: [{ productId: product.id, quantity: 1 }], delivery: 'saekja', customer: CUSTOMER });

    assert.throws(
      () => createOrder({
        tenantId: tenant.id,
        lines: [{ productId: product.id, quantity: 1 }],
        delivery: 'saekja',
        customer: { name: 'Einar Þórsson', phone: '6602222' },
      }),
      /uppselt/i,
    );

    assert.equal(listOrders({ tenantId: tenant.id }).length, 1, 'engin hálfskrifuð pöntun eftir');
  });

  it('geymir verðið eins og það var þegar pantað var', () => {
    const tenant = workshop();
    const product = createProduct(tenant.id, { name: 'Bretti', priceIsk: 40000, stock: 5 });

    const order = createOrder({ tenantId: tenant.id, lines: [{ productId: product.id, quantity: 1 }], delivery: 'saekja', customer: CUSTOMER });
    updateProduct(product.id, { priceIsk: 55000 });

    assert.equal(listOrders({ tenantId: tenant.id })[0]?.items[0]?.unitPriceIsk, 40000);
  });

  it('krefst heimilisfangs þegar senda á vöruna', () => {
    const tenant = workshop();
    const product = createProduct(tenant.id, { name: 'Bretti', priceIsk: 40000, stock: 2 });

    assert.throws(
      () => createOrder({ tenantId: tenant.id, lines: [{ productId: product.id, quantity: 1 }], delivery: 'sending', customer: CUSTOMER }),
      (error: unknown) => error instanceof ValidationError
        && 'heimilisfang' in error.fieldErrors
        && 'postnumer' in error.fieldErrors,
    );
  });

  it('skilar birgðum þegar hætt er við, og tekur þær aftur frá ef pöntunin er endurvakin', () => {
    const tenant = workshop();
    const product = createProduct(tenant.id, { name: 'Bretti', priceIsk: 40000, stock: 2 });
    const order = createOrder({ tenantId: tenant.id, lines: [{ productId: product.id, quantity: 2 }], delivery: 'saekja', customer: CUSTOMER });

    assert.equal(getProductOrThrow(product.id).stock, 0);

    setOrderStatus(order.id, 'haett');
    assert.equal(getProductOrThrow(product.id).stock, 2, 'eintökin fara aftur í hilluna');

    setOrderStatus(order.id, 'stadfest');
    assert.equal(getProductOrThrow(product.id).stock, 0, 'og eru tekin frá aftur');
  });

  it('telur opnar pantanir og veltu', () => {
    const tenant = workshop();
    const product = createProduct(tenant.id, { name: 'Bretti', priceIsk: 40000, madeToOrder: true });

    const first = createOrder({ tenantId: tenant.id, lines: [{ productId: product.id, quantity: 1 }], delivery: 'saekja', customer: CUSTOMER });
    createOrder({ tenantId: tenant.id, lines: [{ productId: product.id, quantity: 1 }], delivery: 'saekja', customer: CUSTOMER });
    setOrderStatus(first.id, 'afhent');

    const stats = orderStats(tenant.id);
    assert.equal(stats.open, 1);
    assert.equal(stats.recent, 2);
    assert.equal(stats.recentIsk, 80000);
  });
});

describe('stillingar verslunar', () => {
  beforeEach(freshDatabase);

  it('fyllir í sjálfgefin gildi þegar ekkert hefur verið stillt', () => {
    const tenant = workshop();
    assert.deepEqual(shopSettings(tenant.id), DEFAULT_SHOP_SETTINGS);
  });

  it('leyfir ekki að báðar afhendingarleiðir séu slökktar', () => {
    const tenant = workshop();
    setFeature(tenant.id, 'vefverslun', true, { allowPickup: false, allowShipping: false });

    const settings = shopSettings(tenant.id);
    assert.ok(settings.allowShipping, 'annars væri verslun sem enginn kemst út úr');
  });
});

describe('verslun á vefsíðunni', () => {
  beforeEach(freshDatabase);

  it('setur vörurnar, verðin og körfuna inn á síðuna', () => {
    const tenant = workshop();
    createProduct(tenant.id, {
      name: 'Skurðarbretti með epoxý', priceIsk: 40000, material: 'Eik og epoxý',
      dimensions: '30 × 40 cm', madeToOrder: true, leadTimeDays: 21,
    });

    const markup = renderSite(loadSiteContent(tenant.id), { variantKey: 'skogur' });

    assert.match(markup, /Skurðarbretti með epoxý/);
    assert.match(markup, /40\.000 kr\./, 'verð er á íslensku sniði');
    assert.match(markup, /Smíðað eftir pöntun · 21 dagar/);
    assert.match(markup, /id="rth-karfa"/, 'karfan fylgir með');
    assert.match(markup, /"@type":"Product"/, 'structured data fyrir leitarvélar');
    assert.match(markup, /schema\.org\/PreOrder/, 'pöntunarvara er PreOrder, ekki InStock');
  });

  it('sleppir versluninni alveg þegar eiginleikinn er ekki virkur', () => {
    const tenant = createTenant({ name: 'Smiðjan Prófun', industry: 'tresmidi' });
    createProduct(tenant.id, { name: 'Bretti', priceIsk: 40000 });

    const markup = renderSite(loadSiteContent(tenant.id), { variantKey: 'skogur' });

    assert.doesNotMatch(markup, /id="rth-karfa"/);
    assert.doesNotMatch(markup, /Bretti/);
  });

  it('teiknar viðaráferð fyrir vöru sem hefur enga mynd', () => {
    const tenant = workshop();
    createProduct(tenant.id, { name: 'Taflborð', priceIsk: 54000, stock: 1 });

    const markup = renderSite(loadSiteContent(tenant.id), { variantKey: 'skogur' });
    assert.match(markup, /class="ware-art"/, 'engin mynd þýðir teiknuð áferð, ekki grár kassi');
  });

  it('gefur körfunni bara það sem hún má panta', () => {
    const tenant = workshop();
    const sold = createProduct(tenant.id, { name: 'Uppselt bretti', priceIsk: 40000, stock: 0 });
    const stocked = createProduct(tenant.id, { name: 'Bretti', priceIsk: 40000, stock: 4 });

    const config = shopConfig(tenant.id) as { vorur: Array<{ id: string; hamark: number }> };

    assert.equal(config.vorur.length, 1);
    assert.equal(config.vorur[0]?.id, stocked.id);
    assert.equal(config.vorur[0]?.hamark, 4, 'hámarkið er það sem er til');
    assert.ok(!config.vorur.some((item) => item.id === sold.id));
  });
});

describe('uppsetning trésmíðaverkstæðis', () => {
  beforeEach(freshDatabase);

  it('setur upp vörulista úr faginu þegar vefverslun er valin', () => {
    const tenant = createTenant({ name: 'Norðanvið Smíði', industry: 'tresmidi' });
    const result = provisionTenant({ tenantId: tenant.id, features: ['vefsida', 'bokanir', 'vefverslun'] });

    const preset = industryPreset('tresmidi');
    assert.equal(result.productsCreated, preset.products?.length);
    assert.ok(result.productsCreated > 0);
    assert.equal(listProducts(tenant.id).length, result.productsCreated);
  });

  it('sleppir vörulistanum þegar vefverslun er ekki valin', () => {
    const tenant = createTenant({ name: 'Norðanvið Smíði', industry: 'tresmidi' });
    const result = provisionTenant({ tenantId: tenant.id, features: ['vefsida', 'bokanir'] });

    assert.equal(result.productsCreated, 0);
    assert.equal(listProducts(tenant.id).length, 0);
  });
});
