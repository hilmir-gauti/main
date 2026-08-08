/**
 * Webstore orders.
 *
 * An order is priced entirely on the server. The basket that arrives from the
 * storefront is treated as a list of *wishes* — product ids and quantities —
 * and every króna on the resulting order is recomputed from the catalogue, so
 * a tampered price in the browser buys nothing.
 *
 * Stock is reserved inside the same transaction that writes the order, which
 * is what stops two people from buying the same one-off piece.
 *
 * There is no card payment here on purpose. These workshops take payment by
 * bank transfer or on collection, and pretending otherwise would mean holding
 * card data for a business that has never asked for it.
 */

import { all, get, run, transaction } from '../../core/db.ts';
import { ValidationError, badRequest, notFound } from '../../core/errors.ts';
import { splitVsk } from '../../core/iceland.ts';
import { id, token } from '../../core/ids.ts';
import { logger } from '../../core/logger.ts';
import { findOrCreateCustomer } from '../customers.ts';
import { emit } from '../events.ts';
import { getFeatures } from '../tenants.ts';
import {
  DEFAULT_SHOP_SETTINGS,
  type OrderDelivery,
  type OrderItem,
  type OrderSource,
  type OrderStatus,
  type ShopOrder,
  type ShopOrderView,
  type ShopSettings,
} from '../types.ts';
import { getProductOrThrow, isAvailable, releaseStock, reserveStock } from './products.ts';

interface OrderRow {
  id: string; tenant_id: string; reference: string; customer_id: string; status: string;
  delivery: string; source: string; address: string; postcode: string; city: string;
  notes: string; internal_notes: string; items_isk: number; shipping_isk: number;
  total_isk: number; vsk_isk: number; status_token: string; confirmation_sent_at: number | null;
  created_at: number; updated_at: number; cancelled_at: number | null;
}

interface ItemRow {
  id: string; order_id: string; product_id: string | null; name: string; variant: string;
  unit_price_isk: number; vsk_rate: number; quantity: number; line_total_isk: number; sort_order: number;
}

function toOrder(row: OrderRow): ShopOrder {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    reference: row.reference,
    customerId: row.customer_id,
    status: row.status as OrderStatus,
    delivery: row.delivery as OrderDelivery,
    source: row.source as OrderSource,
    address: row.address,
    postcode: row.postcode,
    city: row.city,
    notes: row.notes,
    internalNotes: row.internal_notes,
    itemsIsk: row.items_isk,
    shippingIsk: row.shipping_isk,
    totalIsk: row.total_isk,
    vskIsk: row.vsk_isk,
    statusToken: row.status_token,
    confirmationSentAt: row.confirmation_sent_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    cancelledAt: row.cancelled_at,
  };
}

function toItem(row: ItemRow): OrderItem {
  return {
    id: row.id,
    orderId: row.order_id,
    productId: row.product_id,
    name: row.name,
    variant: row.variant,
    unitPriceIsk: row.unit_price_isk,
    vskRate: row.vsk_rate,
    quantity: row.quantity,
    lineTotalIsk: row.line_total_isk,
    sortOrder: row.sort_order,
  };
}

// ---------------------------------------------------------------------------
// Shop settings
// ---------------------------------------------------------------------------

/** Shop policy for a tenant, with every missing value filled from the default. */
export function shopSettings(tenantId: string): ShopSettings {
  const stored = getFeatures(tenantId).vefverslun.config as Record<string, unknown>;
  const number = (value: unknown, fallback: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : fallback;
  };
  const boolean = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);

  const settings: ShopSettings = {
    shippingIsk: number(stored.shippingIsk, DEFAULT_SHOP_SETTINGS.shippingIsk),
    freeShippingOverIsk: number(stored.freeShippingOverIsk, DEFAULT_SHOP_SETTINGS.freeShippingOverIsk),
    allowPickup: boolean(stored.allowPickup, DEFAULT_SHOP_SETTINGS.allowPickup),
    allowShipping: boolean(stored.allowShipping, DEFAULT_SHOP_SETTINGS.allowShipping),
    pickupNote: typeof stored.pickupNote === 'string' ? stored.pickupNote : DEFAULT_SHOP_SETTINGS.pickupNote,
    paymentNote: typeof stored.paymentNote === 'string' && stored.paymentNote.trim()
      ? stored.paymentNote
      : DEFAULT_SHOP_SETTINGS.paymentNote,
  };

  // Both delivery methods off would leave a storefront nobody can order from.
  if (!settings.allowPickup && !settings.allowShipping) settings.allowShipping = true;
  return settings;
}

/** What postage costs for a basket of this size. */
export function shippingFor(settings: ShopSettings, itemsIsk: number, delivery: OrderDelivery): number {
  if (delivery === 'saekja') return 0;
  if (settings.freeShippingOverIsk > 0 && itemsIsk >= settings.freeShippingOverIsk) return 0;
  return settings.shippingIsk;
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

export interface CartLine {
  productId: string;
  quantity: number;
  /** Free text the buyer added to the line, e.g. an engraving. */
  variant?: string;
}

export interface PricedLine extends CartLine {
  name: string;
  unitPriceIsk: number;
  vskRate: number;
  lineTotalIsk: number;
}

export interface PricedCart {
  lines: PricedLine[];
  itemsIsk: number;
  shippingIsk: number;
  totalIsk: number;
  vskIsk: number;
}

const MAX_LINE_QUANTITY = 20;

/**
 * Prices a basket against the live catalogue.
 *
 * Throws on anything that would make the order wrong rather than quietly
 * dropping the line: an unknown product, a piece belonging to another shop, or
 * one that has sold out since the page was loaded.
 */
export function priceCart(tenantId: string, lines: readonly CartLine[], delivery: OrderDelivery): PricedCart {
  if (lines.length === 0) throw new ValidationError({ karfa: 'Karfan er tóm.' });
  if (lines.length > 30) throw badRequest('Of margar vörur í körfu.');

  const priced: PricedLine[] = [];
  let itemsIsk = 0;
  let vskIsk = 0;

  for (const line of lines) {
    const quantity = Math.round(Number(line.quantity));
    if (!Number.isFinite(quantity) || quantity < 1) throw badRequest('Ógildur fjöldi í körfu.');
    if (quantity > MAX_LINE_QUANTITY) {
      throw badRequest(`Hámark ${MAX_LINE_QUANTITY} eintök af hverri vöru — hafðu samband fyrir stærri pantanir.`);
    }

    const product = getProductOrThrow(line.productId);
    if (product.tenantId !== tenantId) throw badRequest('Varan tilheyrir ekki þessari verslun.');
    if (!product.active || !product.isPublic) throw badRequest(`„${product.name}“ er ekki til sölu.`);
    if (!isAvailable(product)) throw badRequest(`„${product.name}“ er uppselt.`);
    if (!product.madeToOrder && product.stock < quantity) {
      throw badRequest(`Aðeins ${product.stock} eintök eru til af „${product.name}“.`);
    }

    const lineTotal = product.priceIsk * quantity;
    itemsIsk += lineTotal;
    vskIsk += splitVsk(lineTotal, product.vskRate).vsk;

    priced.push({
      productId: product.id,
      quantity,
      variant: typeof line.variant === 'string' ? line.variant.trim().slice(0, 200) : '',
      name: product.name,
      unitPriceIsk: product.priceIsk,
      vskRate: product.vskRate,
      lineTotalIsk: lineTotal,
    });
  }

  const shippingIsk = shippingFor(shopSettings(tenantId), itemsIsk, delivery);
  // Postage carries standard VAT, which is already inside the quoted figure.
  if (shippingIsk > 0) vskIsk += splitVsk(shippingIsk).vsk;

  return { lines: priced, itemsIsk, shippingIsk, totalIsk: itemsIsk + shippingIsk, vskIsk };
}

// ---------------------------------------------------------------------------
// Creating an order
// ---------------------------------------------------------------------------

/**
 * Short, unambiguous reference. Uses the same alphabet as the id generator, so
 * it survives being read aloud: no I/L/O/U to confuse with 1/0.
 */
function orderReference(tenantId: string): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  for (let attempt = 0; attempt < 10; attempt++) {
    let suffix = '';
    for (let i = 0; i < 5; i++) suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
    const reference = `P-${suffix}`;
    const clash = get<{ id: string }>('SELECT id FROM shop_order WHERE tenant_id = ? AND reference = ?', tenantId, reference);
    if (!clash) return reference;
  }
  // Effectively unreachable; a timestamp is still unique enough to ship with.
  return `P-${Date.now().toString(36).toUpperCase().slice(-5)}`;
}

export interface CreateOrderInput {
  tenantId: string;
  lines: readonly CartLine[];
  delivery: OrderDelivery;
  source?: OrderSource;
  notes?: string;
  customer: { name: string; phone?: string; email?: string };
  address?: string;
  postcode?: string;
  city?: string;
}

export function createOrder(input: CreateOrderInput): ShopOrderView {
  const settings = shopSettings(input.tenantId);
  const delivery: OrderDelivery = input.delivery === 'sending' ? 'sending' : 'saekja';

  if (delivery === 'sending' && !settings.allowShipping) throw badRequest('Þessi verslun sendir ekki vörur.');
  if (delivery === 'saekja' && !settings.allowPickup) throw badRequest('Það er ekki hægt að sækja pantanir hjá þessari verslun.');

  if (delivery === 'sending') {
    const errors: Record<string, string> = {};
    if (!input.address?.trim()) errors.heimilisfang = 'Sláðu inn heimilisfang fyrir sendingu.';
    if (!/^\d{3}$/.test((input.postcode ?? '').trim())) errors.postnumer = 'Póstnúmer er þrír tölustafir.';
    if (Object.keys(errors).length) throw new ValidationError(errors);
  }

  const cart = priceCart(input.tenantId, input.lines, delivery);

  const order = transaction(() => {
    const customer = findOrCreateCustomer(input.tenantId, {
      name: input.customer.name,
      phone: input.customer.phone,
      email: input.customer.email,
    });

    const orderId = id('pnt');
    const now = Date.now();

    run(
      `INSERT INTO shop_order (
         id, tenant_id, reference, customer_id, status, delivery, source,
         address, postcode, city, notes, internal_notes,
         items_isk, shipping_isk, total_isk, vsk_isk, status_token,
         confirmation_sent_at, created_at, updated_at, cancelled_at
       ) VALUES (?,?,?,?,'ny',?,?,?,?,?,?,'',?,?,?,?,?,NULL,?,?,NULL)`,
      orderId,
      input.tenantId,
      orderReference(input.tenantId),
      customer.id,
      delivery,
      input.source ?? 'vefur',
      delivery === 'sending' ? (input.address ?? '').trim().slice(0, 200) : '',
      delivery === 'sending' ? (input.postcode ?? '').trim().slice(0, 3) : '',
      delivery === 'sending' ? (input.city ?? '').trim().slice(0, 80) : '',
      (input.notes ?? '').trim().slice(0, 1000),
      cart.itemsIsk,
      cart.shippingIsk,
      cart.totalIsk,
      cart.vskIsk,
      token(24),
      now,
      now,
    );

    cart.lines.forEach((line, index) => {
      // Reserving inside the transaction means a sold-out piece rolls the whole
      // order back rather than leaving a half-written basket behind.
      reserveStock(line.productId, line.quantity);

      run(
        `INSERT INTO order_item (
           id, order_id, product_id, name, variant, unit_price_isk, vsk_rate,
           quantity, line_total_isk, sort_order
         ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        id('lin'),
        orderId,
        line.productId,
        line.name,
        line.variant ?? '',
        line.unitPriceIsk,
        line.vskRate,
        line.quantity,
        line.lineTotalIsk,
        index,
      );
    });

    return getOrderOrThrow(orderId);
  });

  logger.info('Pöntun skráð', {
    tenantId: input.tenantId,
    orderId: order.id,
    reference: order.reference,
    totalIsk: order.totalIsk,
  });

  void emit('order.created', { order });
  return order;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function view(row: OrderRow): ShopOrderView {
  const joined = get<{
    customer_name: string; customer_email: string; customer_phone: string;
    tenant_name: string; tenant_timezone: string;
  }>(
    `SELECT c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
            t.name AS tenant_name, t.timezone AS tenant_timezone
       FROM shop_order o
       JOIN customer c ON c.id = o.customer_id
       JOIN tenant t ON t.id = o.tenant_id
      WHERE o.id = ?`,
    row.id,
  );

  return {
    ...toOrder(row),
    items: all<ItemRow>('SELECT * FROM order_item WHERE order_id = ? ORDER BY sort_order', row.id).map(toItem),
    customerName: joined?.customer_name ?? '',
    customerEmail: joined?.customer_email ?? '',
    customerPhone: joined?.customer_phone ?? '',
    tenantName: joined?.tenant_name ?? '',
    tenantTimezone: joined?.tenant_timezone ?? 'Atlantic/Reykjavik',
  };
}

export function getOrder(orderId: string): ShopOrderView | null {
  const row = get<OrderRow>('SELECT * FROM shop_order WHERE id = ?', orderId);
  return row ? view(row) : null;
}

export function getOrderOrThrow(orderId: string): ShopOrderView {
  const order = getOrder(orderId);
  if (!order) throw notFound('Pöntunin fannst ekki.');
  return order;
}

export function getOrderByToken(statusToken: string): ShopOrderView | null {
  if (!statusToken) return null;
  const row = get<OrderRow>('SELECT * FROM shop_order WHERE status_token = ?', statusToken);
  return row ? view(row) : null;
}

export interface ListOrderOptions {
  tenantId?: string;
  status?: OrderStatus;
  /** Only orders the workshop still has to act on. */
  openOnly?: boolean;
  limit?: number;
}

export function listOrders(options: ListOrderOptions = {}): ShopOrderView[] {
  const clauses: string[] = [];
  const params: Array<string | number> = [];

  if (options.tenantId) {
    clauses.push('tenant_id = ?');
    params.push(options.tenantId);
  }
  if (options.status) {
    clauses.push('status = ?');
    params.push(options.status);
  }
  if (options.openOnly) clauses.push("status IN ('ny','stadfest','i_smidum','tilbuin')");

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return all<OrderRow>(
    `SELECT * FROM shop_order ${where} ORDER BY created_at DESC LIMIT ?`,
    ...params,
    Math.min(options.limit ?? 100, 500),
  ).map(view);
}

export interface OrderStats {
  open: number;
  /** Orders placed in the last 30 days. */
  recent: number;
  /** Turnover of orders not cancelled, in the last 30 days. */
  recentIsk: number;
}

export function orderStats(tenantId: string): OrderStats {
  const since = Date.now() - 30 * 24 * 60 * 60_000;
  const row = get<{ open: number; recent: number; recent_isk: number | null }>(
    `SELECT
       SUM(CASE WHEN status IN ('ny','stadfest','i_smidum','tilbuin') THEN 1 ELSE 0 END) AS open,
       SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS recent,
       SUM(CASE WHEN created_at >= ? AND status <> 'haett' THEN total_isk ELSE 0 END) AS recent_isk
     FROM shop_order WHERE tenant_id = ?`,
    since,
    since,
    tenantId,
  );

  return { open: row?.open ?? 0, recent: row?.recent ?? 0, recentIsk: row?.recent_isk ?? 0 };
}

// ---------------------------------------------------------------------------
// Moving an order along
// ---------------------------------------------------------------------------

const STATUSES: readonly OrderStatus[] = ['ny', 'stadfest', 'i_smidum', 'tilbuin', 'afhent', 'haett'];

/**
 * Sets the status of an order.
 *
 * Cancelling returns the reserved stock to the shelf, and un-cancelling takes
 * it off again — a piece must not be sellable twice because someone clicked
 * the wrong row and clicked back.
 */
export function setOrderStatus(orderId: string, status: OrderStatus, options: { internalNotes?: string } = {}): ShopOrderView {
  if (!STATUSES.includes(status)) throw badRequest('Óþekkt staða pöntunar.');

  return transaction(() => {
    const existing = getOrderOrThrow(orderId);
    if (existing.status === status && options.internalNotes === undefined) return existing;

    if (status === 'haett' && existing.status !== 'haett') {
      for (const item of existing.items) {
        if (item.productId) releaseStock(item.productId, item.quantity);
      }
    }
    if (existing.status === 'haett' && status !== 'haett') {
      for (const item of existing.items) {
        if (item.productId) reserveStock(item.productId, item.quantity);
      }
    }

    run(
      `UPDATE shop_order
          SET status = ?,
              internal_notes = COALESCE(?, internal_notes),
              cancelled_at = CASE WHEN ? = 'haett' THEN ? ELSE NULL END,
              updated_at = ?
        WHERE id = ?`,
      status,
      options.internalNotes ?? null,
      status,
      Date.now(),
      Date.now(),
      orderId,
    );

    const updated = getOrderOrThrow(orderId);
    logger.info('Staða pöntunar uppfærð', { orderId, status, reference: updated.reference });
    void emit('order.status', { order: updated, previous: existing.status });
    return updated;
  });
}

/** Records that the customer's confirmation has gone out, so it is sent once. */
export function markOrderConfirmationSent(orderId: string): void {
  run('UPDATE shop_order SET confirmation_sent_at = ? WHERE id = ?', Date.now(), orderId);
}
