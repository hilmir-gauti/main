/**
 * The product catalogue.
 *
 * A product is the webstore's counterpart to a service: the thing a customer
 * can put in a basket. The difference that shapes everything here is that a
 * handmade object is either *in the workshop right now* or *has to be built* —
 * so a product either tracks stock or declares a lead time, never both.
 *
 * Stock is decremented when an order is placed rather than when it ships,
 * because two people buying the same one-off cutting board within a minute of
 * each other is the failure this table exists to prevent.
 */

import { all, get, run, transaction } from '../../core/db.ts';
import { ValidationError, conflict, notFound } from '../../core/errors.ts';
import { id, slugify } from '../../core/ids.ts';
import type { Product } from '../types.ts';

interface ProductRow {
  id: string; tenant_id: string; slug: string; name: string; tagline: string; description: string;
  category: string; material: string; dimensions: string; price_isk: number; vsk_rate: number;
  made_to_order: number; lead_time_days: number; stock: number; image_url: string;
  is_public: number; active: number; sort_order: number;
}

function toProduct(row: ProductRow): Product {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    slug: row.slug,
    name: row.name,
    tagline: row.tagline,
    description: row.description,
    category: row.category,
    material: row.material,
    dimensions: row.dimensions,
    priceIsk: row.price_isk,
    vskRate: row.vsk_rate,
    madeToOrder: row.made_to_order === 1,
    leadTimeDays: row.lead_time_days,
    stock: row.stock,
    imageUrl: row.image_url,
    isPublic: row.is_public === 1,
    active: row.active === 1,
    sortOrder: row.sort_order,
  };
}

/**
 * Whether the storefront may take an order for this product right now.
 *
 * Made-to-order items are always available — the workshop builds another one.
 * Stocked items are available while there is stock, which is what makes a
 * one-off piece disappear from the shop the moment it sells.
 */
export function isAvailable(product: Product): boolean {
  return product.madeToOrder || product.stock > 0;
}

export interface ProductInput {
  name: string;
  slug?: string;
  tagline?: string;
  description?: string;
  category?: string;
  material?: string;
  dimensions?: string;
  priceIsk?: number;
  vskRate?: number;
  madeToOrder?: boolean;
  leadTimeDays?: number;
  stock?: number;
  imageUrl?: string;
  isPublic?: boolean;
  active?: boolean;
  sortOrder?: number;
}

function validateProduct(input: ProductInput): void {
  const errors: Record<string, string> = {};
  if (!input.name?.trim()) errors.name = 'Varan þarf heiti.';
  if (input.priceIsk !== undefined && (!Number.isFinite(input.priceIsk) || input.priceIsk < 0)) {
    errors.priceIsk = 'Verð má ekki vera neikvætt.';
  }
  if (input.stock !== undefined && (!Number.isInteger(input.stock) || input.stock < 0)) {
    errors.stock = 'Birgðir mega ekki vera neikvæðar.';
  }
  if (input.leadTimeDays !== undefined && (!Number.isFinite(input.leadTimeDays) || input.leadTimeDays < 0)) {
    errors.leadTimeDays = 'Afgreiðslutími má ekki vera neikvæður.';
  }
  // Only http(s) images: a generated page is published to a CDN with a strict
  // content policy, and a `javascript:` or `data:` URL here would end up in the
  // markup verbatim.
  if (input.imageUrl && !/^https?:\/\//i.test(input.imageUrl.trim())) {
    errors.imageUrl = 'Slóð myndar þarf að byrja á http:// eða https://.';
  }
  if (Object.keys(errors).length) throw new ValidationError(errors);
}

/** Product slugs are unique per tenant; a clash gets a numeric suffix. */
function uniqueProductSlug(tenantId: string, base: string, exceptId?: string): string {
  const root = slugify(base);
  let candidate = root;
  let counter = 2;

  for (;;) {
    const clash = get<{ id: string }>(
      'SELECT id FROM product WHERE tenant_id = ? AND slug = ?',
      tenantId,
      candidate,
    );
    if (!clash || clash.id === exceptId) return candidate;
    candidate = `${root}-${counter++}`;
  }
}

export function createProduct(tenantId: string, input: ProductInput): Product {
  validateProduct(input);

  const productId = id('vara');
  const now = Date.now();
  const madeToOrder = input.madeToOrder ?? false;
  const orderRow = get<{ m: number | null }>('SELECT MAX(sort_order) AS m FROM product WHERE tenant_id = ?', tenantId);

  run(
    `INSERT INTO product (
       id, tenant_id, slug, name, tagline, description, category, material, dimensions,
       price_isk, vsk_rate, made_to_order, lead_time_days, stock, image_url,
       is_public, active, sort_order, created_at, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    productId,
    tenantId,
    uniqueProductSlug(tenantId, input.slug || input.name),
    input.name.trim(),
    input.tagline?.trim() ?? '',
    input.description?.trim() ?? '',
    input.category?.trim() ?? '',
    input.material?.trim() ?? '',
    input.dimensions?.trim() ?? '',
    Math.max(0, Math.round(input.priceIsk ?? 0)),
    input.vskRate ?? 0.24,
    madeToOrder,
    Math.max(0, Math.round(input.leadTimeDays ?? 0)),
    // A made-to-order piece has no shelf, so its stock column stays at zero.
    madeToOrder ? 0 : Math.max(0, Math.round(input.stock ?? 1)),
    input.imageUrl?.trim() ?? '',
    input.isPublic ?? true,
    input.active ?? true,
    input.sortOrder ?? (orderRow?.m ?? -1) + 1,
    now,
    now,
  );

  return getProductOrThrow(productId);
}

export function getProduct(productId: string): Product | null {
  const row = get<ProductRow>('SELECT * FROM product WHERE id = ?', productId);
  return row ? toProduct(row) : null;
}

export function getProductOrThrow(productId: string): Product {
  const product = getProduct(productId);
  if (!product) throw notFound('Varan fannst ekki.');
  return product;
}

export function getProductBySlug(tenantId: string, slug: string): Product | null {
  const row = get<ProductRow>('SELECT * FROM product WHERE tenant_id = ? AND slug = ?', tenantId, slug);
  return row ? toProduct(row) : null;
}

export interface ListProductOptions {
  includeInactive?: boolean;
  publicOnly?: boolean;
  /** Hide sold-out stocked items, as the storefront does. */
  availableOnly?: boolean;
  category?: string;
}

export function listProducts(tenantId: string, options: ListProductOptions = {}): Product[] {
  const clauses = ['tenant_id = ?'];
  const params: Array<string | number> = [tenantId];

  if (!options.includeInactive) clauses.push('active = 1');
  if (options.publicOnly) clauses.push('is_public = 1');
  if (options.category) {
    clauses.push('category = ?');
    params.push(options.category);
  }

  const rows = all<ProductRow>(
    `SELECT * FROM product WHERE ${clauses.join(' AND ')} ORDER BY sort_order, name COLLATE NOCASE`,
    ...params,
  ).map(toProduct);

  return options.availableOnly ? rows.filter(isAvailable) : rows;
}

/** Categories actually in use, in catalogue order — the storefront's filter row. */
export function listCategories(tenantId: string, options: ListProductOptions = {}): string[] {
  const seen: string[] = [];
  for (const product of listProducts(tenantId, options)) {
    if (product.category && !seen.includes(product.category)) seen.push(product.category);
  }
  return seen;
}

const PRODUCT_COLUMNS: Record<string, string> = {
  name: 'name', tagline: 'tagline', description: 'description', category: 'category',
  material: 'material', dimensions: 'dimensions', priceIsk: 'price_isk', vskRate: 'vsk_rate',
  madeToOrder: 'made_to_order', leadTimeDays: 'lead_time_days', stock: 'stock',
  imageUrl: 'image_url', isPublic: 'is_public', active: 'active', sortOrder: 'sort_order',
};

const BOOLEAN_KEYS = ['madeToOrder', 'isPublic', 'active'];
const INTEGER_KEYS = ['priceIsk', 'leadTimeDays', 'stock', 'sortOrder'];

export function updateProduct(productId: string, patch: Record<string, unknown>): Product {
  const existing = getProductOrThrow(productId);
  const sets: string[] = [];
  const params: Array<string | number> = [];

  for (const [key, column] of Object.entries(PRODUCT_COLUMNS)) {
    if (!(key in patch)) continue;
    let value = patch[key];
    if (value === undefined) continue;

    if (BOOLEAN_KEYS.includes(key)) {
      value = value === true || value === 'on' || value === '1' || value === 1 ? 1 : 0;
    }
    if (INTEGER_KEYS.includes(key)) {
      const num = Number(value);
      if (!Number.isFinite(num)) continue;
      value = Math.max(0, Math.round(num));
    }
    if (key === 'imageUrl') {
      const url = String(value).trim();
      value = /^https?:\/\//i.test(url) ? url : '';
    }
    sets.push(`${column} = ?`);
    params.push(value as string | number);
  }

  // Renaming should move the public URL with it, unless a slug was set by hand.
  if (typeof patch.name === 'string' && patch.name.trim() && patch.slug === undefined) {
    sets.push('slug = ?');
    params.push(uniqueProductSlug(existing.tenantId, patch.name, productId));
  } else if (typeof patch.slug === 'string' && patch.slug.trim()) {
    sets.push('slug = ?');
    params.push(uniqueProductSlug(existing.tenantId, patch.slug, productId));
  }

  if (sets.length === 0) return existing;

  sets.push('updated_at = ?');
  params.push(Date.now());
  params.push(productId);
  run(`UPDATE product SET ${sets.join(', ')} WHERE id = ?`, ...params);

  // Turning stock tracking on for a piece that was made to order leaves it at
  // zero, which would silently hide it. One is the honest default.
  const updated = getProductOrThrow(productId);
  if (!updated.madeToOrder && existing.madeToOrder && updated.stock === 0 && patch.stock === undefined) {
    run('UPDATE product SET stock = 1 WHERE id = ?', productId);
    return getProductOrThrow(productId);
  }
  return updated;
}

/**
 * Reserves stock for an order line.
 *
 * Made-to-order products never run out. Stocked ones are decremented with the
 * count in the WHERE clause, so two concurrent orders for the last board cannot
 * both succeed however they interleave.
 */
export function reserveStock(productId: string, quantity: number): void {
  const product = getProductOrThrow(productId);
  if (product.madeToOrder) return;

  const result = run(
    'UPDATE product SET stock = stock - ?, updated_at = ? WHERE id = ? AND stock >= ?',
    quantity,
    Date.now(),
    productId,
    quantity,
  );

  if (result.changes === 0) {
    throw conflict(
      product.stock > 0
        ? `Aðeins ${product.stock} eintök eru til af „${product.name}“.`
        : `„${product.name}“ er uppselt.`,
      { productId },
    );
  }
}

/** Puts stock back when an order is cancelled. */
export function releaseStock(productId: string, quantity: number): void {
  const product = getProduct(productId);
  if (!product || product.madeToOrder) return;
  run('UPDATE product SET stock = stock + ?, updated_at = ? WHERE id = ?', quantity, Date.now(), productId);
}

/**
 * Products are soft-deleted once they appear on an order, so an old order still
 * shows what was bought even after the piece leaves the catalogue.
 */
export function deleteProduct(productId: string): { deleted: boolean } {
  const used = get<{ c: number }>('SELECT COUNT(*) AS c FROM order_item WHERE product_id = ?', productId);
  if ((used?.c ?? 0) > 0) {
    run('UPDATE product SET active = 0, is_public = 0, updated_at = ? WHERE id = ?', Date.now(), productId);
    return { deleted: false };
  }
  run('DELETE FROM product WHERE id = ?', productId);
  return { deleted: true };
}

/** Applies an industry preset's product list to a freshly created tenant. */
export function applyPresetProducts(
  tenantId: string,
  products: readonly ProductInput[],
): Product[] {
  return transaction(() =>
    products.map((preset, index) => createProduct(tenantId, { ...preset, sortOrder: index })),
  );
}
