/**
 * End customers — the people who book appointments with a tenant.
 *
 * Customers are identified by phone number within a tenant, because that is
 * the one field present in every channel: the web form, the phone receptionist
 * (which has caller ID) and a booking taken at the counter. Matching on it
 * means a regular is recognised however they get in touch.
 */

import { all, get, run } from '../core/db.ts';
import { ValidationError, notFound } from '../core/errors.ts';
import { isValidEmail, normalizePhone, validateKennitala } from '../core/iceland.ts';
import { id } from '../core/ids.ts';
import type { Customer } from './types.ts';

interface CustomerRow {
  id: string; tenant_id: string; name: string; email: string; phone: string;
  kennitala: string | null; notes: string; marketing_consent: number;
  no_show_count: number; created_at: number; updated_at: number;
}

function toCustomer(row: CustomerRow): Customer {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    kennitala: row.kennitala,
    notes: row.notes,
    marketingConsent: row.marketing_consent === 1,
    noShowCount: row.no_show_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CustomerInput {
  name: string;
  phone?: string;
  email?: string;
  kennitala?: string;
  notes?: string;
  marketingConsent?: boolean;
}

export function validateCustomerInput(input: CustomerInput): Record<string, string> {
  const errors: Record<string, string> = {};

  if (!input.name?.trim()) {
    errors.name = 'Sláðu inn nafn.';
  } else if (input.name.trim().length > 120) {
    errors.name = 'Nafnið er of langt.';
  }

  // At least one way to reach them, or a confirmation cannot be sent.
  const phone = input.phone ? normalizePhone(input.phone) : null;
  const hasEmail = Boolean(input.email?.trim());

  if (!phone?.valid && !hasEmail) {
    errors.phone = 'Sláðu inn símanúmer eða netfang svo hægt sé að senda staðfestingu.';
  }
  if (input.phone?.trim() && !phone?.valid) {
    errors.phone = 'Símanúmerið er ógilt. Notaðu 7 tölustafi, t.d. 555 1234.';
  }
  if (hasEmail && !isValidEmail(input.email!)) {
    errors.email = 'Netfangið er ógilt.';
  }
  if (input.kennitala?.trim()) {
    const kt = validateKennitala(input.kennitala);
    if (!kt.valid) errors.kennitala = kt.reason ?? 'Kennitalan er ógild.';
  }

  return errors;
}

/**
 * Finds an existing customer by phone (or email as a fallback) and updates any
 * newly supplied details, otherwise creates one.
 *
 * Existing values are never overwritten with blanks — a phone booking that
 * captures only a name must not wipe the email address we already had.
 */
export function findOrCreateCustomer(tenantId: string, input: CustomerInput): Customer {
  const errors = validateCustomerInput(input);
  if (Object.keys(errors).length > 0) throw new ValidationError(errors);

  const phone = input.phone ? normalizePhone(input.phone) : null;
  const normalizedPhone = phone?.valid ? phone.e164 : '';
  const email = input.email?.trim().toLowerCase() ?? '';

  let existing: CustomerRow | null = null;
  if (normalizedPhone) {
    existing = get<CustomerRow>('SELECT * FROM customer WHERE tenant_id = ? AND phone = ?', tenantId, normalizedPhone);
  }
  if (!existing && email) {
    existing = get<CustomerRow>('SELECT * FROM customer WHERE tenant_id = ? AND email = ? AND email <> \'\'', tenantId, email);
  }

  const now = Date.now();

  if (existing) {
    run(
      `UPDATE customer SET
         name = ?,
         email = CASE WHEN ? <> '' THEN ? ELSE email END,
         phone = CASE WHEN ? <> '' THEN ? ELSE phone END,
         kennitala = COALESCE(?, kennitala),
         notes = CASE WHEN ? <> '' THEN ? ELSE notes END,
         marketing_consent = ?,
         updated_at = ?
       WHERE id = ?`,
      input.name.trim(),
      email, email,
      normalizedPhone, normalizedPhone,
      input.kennitala ? validateKennitala(input.kennitala).normalized : null,
      input.notes?.trim() ?? '', input.notes?.trim() ?? '',
      input.marketingConsent ?? existing.marketing_consent === 1,
      now,
      existing.id,
    );
    return getCustomerOrThrow(existing.id);
  }

  const customerId = id('kun');
  run(
    `INSERT INTO customer (id, tenant_id, name, email, phone, kennitala, notes, marketing_consent, no_show_count, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,0,?,?)`,
    customerId,
    tenantId,
    input.name.trim(),
    email,
    normalizedPhone,
    input.kennitala ? validateKennitala(input.kennitala).normalized : null,
    input.notes?.trim() ?? '',
    input.marketingConsent ?? false,
    now,
    now,
  );

  return getCustomerOrThrow(customerId);
}

export function getCustomer(customerId: string): Customer | null {
  const row = get<CustomerRow>('SELECT * FROM customer WHERE id = ?', customerId);
  return row ? toCustomer(row) : null;
}

export function getCustomerOrThrow(customerId: string): Customer {
  const customer = getCustomer(customerId);
  if (!customer) throw notFound('Viðskiptavinur fannst ekki.');
  return customer;
}

export function findCustomerByPhone(tenantId: string, phone: string): Customer | null {
  const normalized = normalizePhone(phone);
  if (!normalized.valid) return null;
  const row = get<CustomerRow>('SELECT * FROM customer WHERE tenant_id = ? AND phone = ?', tenantId, normalized.e164);
  return row ? toCustomer(row) : null;
}

export function listCustomers(tenantId: string, options: { search?: string; limit?: number } = {}): Customer[] {
  const limit = Math.min(options.limit ?? 100, 500);
  if (options.search?.trim()) {
    const like = `%${options.search.trim()}%`;
    return all<CustomerRow>(
      `SELECT * FROM customer WHERE tenant_id = ? AND (name LIKE ? OR phone LIKE ? OR email LIKE ?)
       ORDER BY updated_at DESC LIMIT ?`,
      tenantId, like, like, like, limit,
    ).map(toCustomer);
  }
  return all<CustomerRow>(
    'SELECT * FROM customer WHERE tenant_id = ? ORDER BY updated_at DESC LIMIT ?',
    tenantId, limit,
  ).map(toCustomer);
}

export function updateCustomer(customerId: string, patch: Partial<CustomerInput>): Customer {
  getCustomerOrThrow(customerId);
  const sets: string[] = [];
  const params: Array<string | number | null> = [];

  if (patch.name !== undefined) {
    sets.push('name = ?');
    params.push(patch.name.trim());
  }
  if (patch.email !== undefined) {
    if (patch.email.trim() && !isValidEmail(patch.email)) {
      throw new ValidationError({ email: 'Netfangið er ógilt.' });
    }
    sets.push('email = ?');
    params.push(patch.email.trim().toLowerCase());
  }
  if (patch.phone !== undefined) {
    const phone = normalizePhone(patch.phone);
    if (patch.phone.trim() && !phone.valid) {
      throw new ValidationError({ phone: 'Símanúmerið er ógilt.' });
    }
    sets.push('phone = ?');
    params.push(phone.valid ? phone.e164 : '');
  }
  if (patch.notes !== undefined) {
    sets.push('notes = ?');
    params.push(patch.notes.trim());
  }
  if (patch.marketingConsent !== undefined) {
    sets.push('marketing_consent = ?');
    params.push(patch.marketingConsent ? 1 : 0);
  }

  if (sets.length === 0) return getCustomerOrThrow(customerId);

  sets.push('updated_at = ?');
  params.push(Date.now());
  params.push(customerId);
  run(`UPDATE customer SET ${sets.join(', ')} WHERE id = ?`, ...params);
  return getCustomerOrThrow(customerId);
}

export function recordNoShow(customerId: string): void {
  run('UPDATE customer SET no_show_count = no_show_count + 1, updated_at = ? WHERE id = ?', Date.now(), customerId);
}
