/**
 * Service catalogue and staff.
 *
 * A service defines how long an appointment takes and how much slack to leave
 * around it; a staff member defines who can perform it. Together they decide
 * what the availability engine is allowed to offer.
 */

import { all, get, run, transaction } from '../core/db.ts';
import { ValidationError, notFound } from '../core/errors.ts';
import { normalizePhone } from '../core/iceland.ts';
import { id } from '../core/ids.ts';
import type { Service, Staff } from './types.ts';

interface ServiceRow {
  id: string; tenant_id: string; name: string; description: string;
  duration_min: number; buffer_before_min: number; buffer_after_min: number;
  price_isk: number; vsk_rate: number; capacity: number;
  requires_staff: number; is_public: number; active: number; sort_order: number; color: string;
}

interface StaffRow {
  id: string; tenant_id: string; name: string; title: string; email: string; phone: string;
  color: string; accepts_bookings: number; google_calendar_id: string; active: number; sort_order: number;
}

function toService(row: ServiceRow): Service {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    description: row.description,
    durationMin: row.duration_min,
    bufferBeforeMin: row.buffer_before_min,
    bufferAfterMin: row.buffer_after_min,
    priceIsk: row.price_isk,
    vskRate: row.vsk_rate,
    capacity: row.capacity,
    requiresStaff: row.requires_staff === 1,
    isPublic: row.is_public === 1,
    active: row.active === 1,
    sortOrder: row.sort_order,
    color: row.color,
  };
}

function toStaff(row: StaffRow): Staff {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    title: row.title,
    email: row.email,
    phone: row.phone,
    color: row.color,
    acceptsBookings: row.accepts_bookings === 1,
    googleCalendarId: row.google_calendar_id,
    active: row.active === 1,
    sortOrder: row.sort_order,
  };
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

export interface ServiceInput {
  name: string;
  description?: string;
  durationMin: number;
  bufferBeforeMin?: number;
  bufferAfterMin?: number;
  priceIsk?: number;
  vskRate?: number;
  capacity?: number;
  requiresStaff?: boolean;
  isPublic?: boolean;
  active?: boolean;
  sortOrder?: number;
  color?: string;
}

function validateService(input: ServiceInput): void {
  const errors: Record<string, string> = {};
  if (!input.name?.trim()) errors.name = 'Þjónustan þarf heiti.';
  if (!Number.isFinite(input.durationMin) || input.durationMin <= 0) {
    errors.durationMin = 'Lengd verður að vera stærri en núll.';
  } else if (input.durationMin > 1440) {
    errors.durationMin = 'Lengd getur mest verið 24 klukkustundir.';
  }
  if (input.priceIsk !== undefined && (!Number.isFinite(input.priceIsk) || input.priceIsk < 0)) {
    errors.priceIsk = 'Verð má ekki vera neikvætt.';
  }
  if (input.capacity !== undefined && (!Number.isInteger(input.capacity) || input.capacity < 1)) {
    errors.capacity = 'Fjöldi samtímis verður að vera að minnsta kosti 1.';
  }
  if (Object.keys(errors).length) throw new ValidationError(errors);
}

export function createService(tenantId: string, input: ServiceInput): Service {
  validateService(input);
  const serviceId = id('thj');
  const now = Date.now();
  const nextOrder = input.sortOrder ?? nextServiceOrder(tenantId);

  run(
    `INSERT INTO service (
       id, tenant_id, name, description, duration_min, buffer_before_min, buffer_after_min,
       price_isk, vsk_rate, capacity, requires_staff, is_public, active, sort_order, color,
       created_at, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    serviceId,
    tenantId,
    input.name.trim(),
    input.description?.trim() ?? '',
    Math.round(input.durationMin),
    Math.max(0, Math.round(input.bufferBeforeMin ?? 0)),
    Math.max(0, Math.round(input.bufferAfterMin ?? 0)),
    Math.max(0, Math.round(input.priceIsk ?? 0)),
    input.vskRate ?? 0.24,
    Math.max(1, Math.round(input.capacity ?? 1)),
    input.requiresStaff ?? true,
    input.isPublic ?? true,
    input.active ?? true,
    nextOrder,
    input.color ?? '',
    now,
    now,
  );

  return getServiceOrThrow(serviceId);
}

function nextServiceOrder(tenantId: string): number {
  const row = get<{ m: number | null }>('SELECT MAX(sort_order) AS m FROM service WHERE tenant_id = ?', tenantId);
  return (row?.m ?? -1) + 1;
}

export function getService(serviceId: string): Service | null {
  const row = get<ServiceRow>('SELECT * FROM service WHERE id = ?', serviceId);
  return row ? toService(row) : null;
}

export function getServiceOrThrow(serviceId: string): Service {
  const service = getService(serviceId);
  if (!service) throw notFound('Þjónustan fannst ekki.');
  return service;
}

export function listServices(tenantId: string, options: { includeInactive?: boolean; publicOnly?: boolean } = {}): Service[] {
  const clauses = ['tenant_id = ?'];
  if (!options.includeInactive) clauses.push('active = 1');
  if (options.publicOnly) clauses.push('is_public = 1');
  return all<ServiceRow>(
    `SELECT * FROM service WHERE ${clauses.join(' AND ')} ORDER BY sort_order, name COLLATE NOCASE`,
    tenantId,
  ).map(toService);
}

const SERVICE_COLUMNS: Record<string, string> = {
  name: 'name', description: 'description', durationMin: 'duration_min',
  bufferBeforeMin: 'buffer_before_min', bufferAfterMin: 'buffer_after_min',
  priceIsk: 'price_isk', vskRate: 'vsk_rate', capacity: 'capacity',
  requiresStaff: 'requires_staff', isPublic: 'is_public', active: 'active',
  sortOrder: 'sort_order', color: 'color',
};

export function updateService(serviceId: string, patch: Record<string, unknown>): Service {
  getServiceOrThrow(serviceId);
  const sets: string[] = [];
  const params: Array<string | number> = [];

  for (const [key, column] of Object.entries(SERVICE_COLUMNS)) {
    if (!(key in patch)) continue;
    let value = patch[key];
    if (value === undefined) continue;
    if (['requiresStaff', 'isPublic', 'active'].includes(key)) {
      value = value === true || value === 'on' || value === '1' || value === 1 ? 1 : 0;
    }
    if (['durationMin', 'bufferBeforeMin', 'bufferAfterMin', 'priceIsk', 'capacity', 'sortOrder'].includes(key)) {
      const num = Number(value);
      if (!Number.isFinite(num)) continue;
      value = Math.round(num);
    }
    sets.push(`${column} = ?`);
    params.push(value as string | number);
  }

  if (sets.length === 0) return getServiceOrThrow(serviceId);
  sets.push('updated_at = ?');
  params.push(Date.now());
  params.push(serviceId);
  run(`UPDATE service SET ${sets.join(', ')} WHERE id = ?`, ...params);
  return getServiceOrThrow(serviceId);
}

/**
 * Services are soft-deleted when they have history, because bookings reference
 * them with ON DELETE RESTRICT and an old appointment should still show what
 * it was for.
 */
export function deleteService(serviceId: string): { deleted: boolean } {
  const used = get<{ c: number }>('SELECT COUNT(*) AS c FROM booking WHERE service_id = ?', serviceId);
  if ((used?.c ?? 0) > 0) {
    run('UPDATE service SET active = 0, is_public = 0, updated_at = ? WHERE id = ?', Date.now(), serviceId);
    return { deleted: false };
  }
  run('DELETE FROM service WHERE id = ?', serviceId);
  return { deleted: true };
}

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------

export interface StaffInput {
  name: string;
  title?: string;
  email?: string;
  phone?: string;
  color?: string;
  acceptsBookings?: boolean;
  googleCalendarId?: string;
  active?: boolean;
  sortOrder?: number;
}

export function createStaff(tenantId: string, input: StaffInput): Staff {
  if (!input.name?.trim()) throw new ValidationError({ name: 'Starfsmaður þarf nafn.' });

  const staffId = id('stf');
  const now = Date.now();
  const phone = input.phone ? normalizePhone(input.phone) : null;
  const orderRow = get<{ m: number | null }>('SELECT MAX(sort_order) AS m FROM staff WHERE tenant_id = ?', tenantId);

  run(
    `INSERT INTO staff (
       id, tenant_id, name, title, email, phone, color, accepts_bookings,
       google_calendar_id, active, sort_order, created_at, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    staffId,
    tenantId,
    input.name.trim(),
    input.title?.trim() ?? '',
    input.email?.trim().toLowerCase() ?? '',
    phone?.valid ? phone.e164 : '',
    input.color ?? '',
    input.acceptsBookings ?? true,
    input.googleCalendarId ?? '',
    input.active ?? true,
    input.sortOrder ?? (orderRow?.m ?? -1) + 1,
    now,
    now,
  );

  return getStaffOrThrow(staffId);
}

export function getStaff(staffId: string): Staff | null {
  const row = get<StaffRow>('SELECT * FROM staff WHERE id = ?', staffId);
  return row ? toStaff(row) : null;
}

export function getStaffOrThrow(staffId: string): Staff {
  const staff = getStaff(staffId);
  if (!staff) throw notFound('Starfsmaður fannst ekki.');
  return staff;
}

export function listStaff(tenantId: string, options: { includeInactive?: boolean; bookableOnly?: boolean } = {}): Staff[] {
  const clauses = ['tenant_id = ?'];
  if (!options.includeInactive) clauses.push('active = 1');
  if (options.bookableOnly) clauses.push('accepts_bookings = 1');
  return all<StaffRow>(
    `SELECT * FROM staff WHERE ${clauses.join(' AND ')} ORDER BY sort_order, name COLLATE NOCASE`,
    tenantId,
  ).map(toStaff);
}

const STAFF_COLUMNS: Record<string, string> = {
  name: 'name', title: 'title', email: 'email', phone: 'phone', color: 'color',
  acceptsBookings: 'accepts_bookings', googleCalendarId: 'google_calendar_id',
  active: 'active', sortOrder: 'sort_order',
};

export function updateStaff(staffId: string, patch: Record<string, unknown>): Staff {
  getStaffOrThrow(staffId);
  const sets: string[] = [];
  const params: Array<string | number> = [];

  for (const [key, column] of Object.entries(STAFF_COLUMNS)) {
    if (!(key in patch)) continue;
    let value = patch[key];
    if (value === undefined) continue;
    if (key === 'acceptsBookings' || key === 'active') {
      value = value === true || value === 'on' || value === '1' || value === 1 ? 1 : 0;
    }
    if (key === 'phone') {
      const phone = normalizePhone(String(value));
      value = phone.valid ? phone.e164 : '';
    }
    sets.push(`${column} = ?`);
    params.push(value as string | number);
  }

  if (sets.length === 0) return getStaffOrThrow(staffId);
  sets.push('updated_at = ?');
  params.push(Date.now());
  params.push(staffId);
  run(`UPDATE staff SET ${sets.join(', ')} WHERE id = ?`, ...params);
  return getStaffOrThrow(staffId);
}

export function deleteStaff(staffId: string): { deleted: boolean } {
  const used = get<{ c: number }>('SELECT COUNT(*) AS c FROM booking WHERE staff_id = ?', staffId);
  if ((used?.c ?? 0) > 0) {
    run('UPDATE staff SET active = 0, accepts_bookings = 0, updated_at = ? WHERE id = ?', Date.now(), staffId);
    return { deleted: false };
  }
  run('DELETE FROM staff WHERE id = ?', staffId);
  return { deleted: true };
}

// ---------------------------------------------------------------------------
// Which staff can perform which service
// ---------------------------------------------------------------------------

/**
 * An empty assignment list is meaningful: it means "anyone can do this".
 * That keeps single-person businesses from having to wire up a matrix, while
 * letting a larger salon restrict colouring to the colourists.
 */
export function setStaffServices(staffId: string, serviceIds: readonly string[]): void {
  transaction(() => {
    run('DELETE FROM staff_service WHERE staff_id = ?', staffId);
    for (const serviceId of serviceIds) {
      run('INSERT OR IGNORE INTO staff_service (staff_id, service_id) VALUES (?, ?)', staffId, serviceId);
    }
  });
}

export function getStaffServiceIds(staffId: string): string[] {
  return all<{ service_id: string }>('SELECT service_id FROM staff_service WHERE staff_id = ?', staffId).map(
    (r) => r.service_id,
  );
}

/** Staff eligible to perform a service, honouring the "empty means any" rule. */
export function staffForService(tenantId: string, serviceId: string): Staff[] {
  const assigned = all<StaffRow>(
    `SELECT s.* FROM staff s
       JOIN staff_service ss ON ss.staff_id = s.id
      WHERE s.tenant_id = ? AND ss.service_id = ? AND s.active = 1 AND s.accepts_bookings = 1
      ORDER BY s.sort_order, s.name COLLATE NOCASE`,
    tenantId,
    serviceId,
  ).map(toStaff);

  if (assigned.length > 0) return assigned;

  // No explicit assignment: any bookable staff member who has no assignments
  // of their own is eligible. A colourist restricted to colouring should not
  // be offered for haircuts just because haircuts have no restrictions.
  return listStaff(tenantId, { bookableOnly: true }).filter(
    (member) => getStaffServiceIds(member.id).length === 0,
  );
}

/** Applies an industry preset's services to a freshly created tenant. */
export function applyPresetServices(
  tenantId: string,
  services: ReadonlyArray<{ name: string; description: string; durationMin: number; priceIsk: number; bufferAfterMin?: number; vskRate?: number; capacity?: number }>,
): Service[] {
  return transaction(() =>
    services.map((preset, index) =>
      createService(tenantId, {
        name: preset.name,
        description: preset.description,
        durationMin: preset.durationMin,
        priceIsk: preset.priceIsk,
        bufferAfterMin: preset.bufferAfterMin ?? 0,
        vskRate: preset.vskRate ?? 0.24,
        capacity: preset.capacity ?? 1,
        sortOrder: index,
      }),
    ),
  );
}
