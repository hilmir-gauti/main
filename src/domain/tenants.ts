/**
 * Tenants — the small businesses Rafræn Þjónusta serves.
 *
 * A tenant owns everything else in the system: services, staff, opening hours,
 * bookings, its generated website and its phone number. Deleting one cascades
 * through the schema.
 */

import { all, fromJson, get, run, toJson, transaction } from '../core/db.ts';
import { ValidationError, notFound } from '../core/errors.ts';
import { formatKennitala, isValidEmail, normalizePhone, placeForPostcode, validateKennitala } from '../core/iceland.ts';
import { id, slugify } from '../core/ids.ts';
import { logger } from '../core/logger.ts';
import { config } from '../config.ts';
import { industryPreset } from './industries.ts';
import { FEATURES, type Feature, type Tenant, type TenantStatus } from './types.ts';

interface TenantRow {
  id: string; slug: string; name: string; legal_name: string; kennitala: string | null;
  industry: string; tagline: string; about: string; email: string; phone: string;
  website_domain: string; address: string; postcode: string; city: string;
  timezone: string; locale: string; currency: string;
  brand_color: string; accent_color: string; logo_url: string;
  slot_granularity_min: number; min_notice_min: number; max_advance_days: number;
  cancel_window_hours: number; respect_holidays: number; auto_confirm: number;
  greeting: string; forward_number: string; voicemail_email: string;
  status: string; plan: string; notes: string;
  created_at: number; updated_at: number;
}

function toTenant(row: TenantRow): Tenant {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    legalName: row.legal_name,
    kennitala: row.kennitala,
    industry: row.industry,
    tagline: row.tagline,
    about: row.about,
    email: row.email,
    phone: row.phone,
    websiteDomain: row.website_domain,
    address: row.address,
    postcode: row.postcode,
    city: row.city,
    timezone: row.timezone,
    locale: row.locale,
    currency: row.currency,
    brandColor: row.brand_color,
    accentColor: row.accent_color,
    logoUrl: row.logo_url,
    slotGranularityMin: row.slot_granularity_min,
    minNoticeMin: row.min_notice_min,
    maxAdvanceDays: row.max_advance_days,
    cancelWindowHours: row.cancel_window_hours,
    respectHolidays: row.respect_holidays === 1,
    autoConfirm: row.auto_confirm === 1,
    greeting: row.greeting,
    forwardNumber: row.forward_number,
    voicemailEmail: row.voicemail_email,
    status: row.status as TenantStatus,
    plan: row.plan,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateTenantInput {
  name: string;
  industry: string;
  legalName?: string;
  kennitala?: string;
  email?: string;
  phone?: string;
  websiteDomain?: string;
  address?: string;
  postcode?: string;
  city?: string;
  tagline?: string;
  about?: string;
  brandColor?: string;
  slug?: string;
  notes?: string;
}

/** Validates onboarding input, returning field-keyed Icelandic messages. */
export function validateTenantInput(input: CreateTenantInput, options: { existingId?: string } = {}): Record<string, string> {
  const errors: Record<string, string> = {};

  const name = input.name?.trim() ?? '';
  if (name.length < 2) errors.name = 'Sláðu inn nafn fyrirtækisins.';
  if (name.length > 120) errors.name = 'Nafnið er of langt (hámark 120 stafir).';

  if (input.kennitala) {
    const kt = validateKennitala(input.kennitala);
    if (!kt.valid) errors.kennitala = kt.reason ?? 'Kennitalan er ógild.';
    else if (kt.type !== 'fyrirtaeki' && kt.type !== 'einstaklingur') errors.kennitala = 'Kennitalan er ógild.';
  }

  if (input.email && !isValidEmail(input.email)) {
    errors.email = 'Netfangið er ógilt.';
  }

  if (input.phone) {
    const phone = normalizePhone(input.phone);
    if (!phone.valid) errors.phone = 'Símanúmerið er ógilt. Notaðu 7 tölustafi, t.d. 555 1234.';
  }

  if (input.postcode && !placeForPostcode(input.postcode)) {
    errors.postcode = 'Óþekkt póstnúmer.';
  }

  if (input.websiteDomain) {
    const domain = input.websiteDomain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
      errors.websiteDomain = 'Lénið er ógilt. Dæmi: fyrirtaeki.is';
    }
  }

  if (input.brandColor && !/^#[0-9a-fA-F]{6}$/.test(input.brandColor)) {
    errors.brandColor = 'Litur verður að vera á forminu #1d4ed8.';
  }

  const slug = (input.slug?.trim() || slugify(name));
  if (slug) {
    const clash = get<{ id: string }>('SELECT id FROM tenant WHERE slug = ?', slug);
    if (clash && clash.id !== options.existingId) {
      errors.slug = `Auðkennið „${slug}“ er þegar í notkun. Veldu annað.`;
    }
  }

  return errors;
}

/** Generates a slug that does not collide, appending -2, -3 … as needed. */
export function uniqueSlug(base: string): string {
  const root = slugify(base);
  let candidate = root;
  let counter = 2;
  while (get('SELECT id FROM tenant WHERE slug = ?', candidate)) {
    candidate = `${root}-${counter++}`;
    if (counter > 999) return `${root}-${Date.now()}`;
  }
  return candidate;
}

export function createTenant(input: CreateTenantInput): Tenant {
  const errors = validateTenantInput(input);
  if (Object.keys(errors).length > 0) throw new ValidationError(errors);

  const preset = industryPreset(input.industry);
  const now = Date.now();
  const tenantId = id('vsk');
  const slug = input.slug?.trim() || uniqueSlug(input.name);
  const phone = input.phone ? normalizePhone(input.phone) : null;
  const postcode = input.postcode?.trim() ?? '';
  const city = input.city?.trim() || (postcode ? placeForPostcode(postcode) ?? '' : '');

  run(
    `INSERT INTO tenant (
       id, slug, name, legal_name, kennitala, industry, tagline, about, email, phone,
       website_domain, address, postcode, city, timezone, locale, currency,
       brand_color, accent_color, logo_url,
       slot_granularity_min, min_notice_min, max_advance_days, cancel_window_hours,
       respect_holidays, auto_confirm, greeting, forward_number, voicemail_email,
       status, plan, notes, created_at, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    tenantId,
    slug,
    input.name.trim(),
    input.legalName?.trim() ?? '',
    input.kennitala ? validateKennitala(input.kennitala).normalized : null,
    preset.key,
    input.tagline?.trim() || preset.tagline,
    input.about?.trim() || preset.about,
    input.email?.trim().toLowerCase() ?? '',
    phone?.valid ? phone.e164 : '',
    input.websiteDomain?.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '') ?? '',
    input.address?.trim() ?? '',
    postcode,
    city,
    config.defaults.timezone,
    config.defaults.locale,
    config.defaults.currency,
    input.brandColor ?? '#1d4ed8',
    '#0f172a',
    '',
    config.booking.slotGranularityMin,
    120,
    config.booking.maxAdvanceDays,
    24,
    1,
    1,
    preset.greeting.replace('{name}', input.name.trim()),
    '',
    input.email?.trim().toLowerCase() ?? '',
    'undirbuningur',
    'grunnur',
    input.notes?.trim() ?? '',
    now,
    now,
  );

  logger.info('Viðskiptavinur stofnaður', { tenantId, slug, industry: preset.key });
  return getTenantOrThrow(tenantId);
}

export function getTenant(tenantId: string): Tenant | null {
  const row = get<TenantRow>('SELECT * FROM tenant WHERE id = ?', tenantId);
  return row ? toTenant(row) : null;
}

export function getTenantOrThrow(tenantId: string): Tenant {
  const tenant = getTenant(tenantId);
  if (!tenant) throw notFound('Viðskiptavinur fannst ekki.');
  return tenant;
}

export function getTenantBySlug(slug: string): Tenant | null {
  const row = get<TenantRow>('SELECT * FROM tenant WHERE slug = ?', slug);
  return row ? toTenant(row) : null;
}

/** Resolves a tenant by the domain a request arrived on (for hosted sites). */
export function getTenantByDomain(domain: string): Tenant | null {
  const clean = domain.toLowerCase().replace(/^www\./, '').split(':')[0] ?? '';
  const row = get<TenantRow>('SELECT * FROM tenant WHERE website_domain IN (?, ?)', clean, `www.${clean}`);
  return row ? toTenant(row) : null;
}

export function listTenants(options: { status?: TenantStatus; search?: string } = {}): Tenant[] {
  const clauses: string[] = [];
  const params: Array<string> = [];

  if (options.status) {
    clauses.push('status = ?');
    params.push(options.status);
  }
  if (options.search?.trim()) {
    clauses.push('(name LIKE ? OR slug LIKE ? OR email LIKE ?)');
    const like = `%${options.search.trim()}%`;
    params.push(like, like, like);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return all<TenantRow>(`SELECT * FROM tenant ${where} ORDER BY name COLLATE NOCASE`, ...params).map(toTenant);
}

/** Columns the admin console is allowed to update directly. */
const UPDATABLE: Record<string, string> = {
  name: 'name', legalName: 'legal_name', kennitala: 'kennitala', industry: 'industry',
  tagline: 'tagline', about: 'about', email: 'email', phone: 'phone',
  websiteDomain: 'website_domain', address: 'address', postcode: 'postcode', city: 'city',
  timezone: 'timezone', brandColor: 'brand_color', accentColor: 'accent_color', logoUrl: 'logo_url',
  slotGranularityMin: 'slot_granularity_min', minNoticeMin: 'min_notice_min',
  maxAdvanceDays: 'max_advance_days', cancelWindowHours: 'cancel_window_hours',
  respectHolidays: 'respect_holidays', autoConfirm: 'auto_confirm',
  greeting: 'greeting', forwardNumber: 'forward_number', voicemailEmail: 'voicemail_email',
  status: 'status', plan: 'plan', notes: 'notes', slug: 'slug',
};

export function updateTenant(tenantId: string, patch: Partial<Record<keyof typeof UPDATABLE, unknown>>): Tenant {
  const tenant = getTenantOrThrow(tenantId);

  const sets: string[] = [];
  const params: Array<string | number | null> = [];

  for (const [key, column] of Object.entries(UPDATABLE)) {
    if (!(key in patch)) continue;
    let value = patch[key as keyof typeof UPDATABLE];

    if (value === undefined) continue;
    if (key === 'phone' || key === 'forwardNumber') {
      const phone = normalizePhone(String(value));
      value = phone.valid ? phone.e164 : '';
    }
    if (key === 'kennitala') {
      const kt = validateKennitala(String(value));
      if (String(value).trim() !== '' && !kt.valid) {
        throw new ValidationError({ kennitala: kt.reason ?? 'Kennitalan er ógild.' });
      }
      value = kt.valid ? kt.normalized : null;
    }
    if (key === 'websiteDomain') {
      value = String(value).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    }
    if (key === 'respectHolidays' || key === 'autoConfirm') {
      value = value === true || value === 'on' || value === '1' || value === 1 ? 1 : 0;
    }
    if (key === 'slug') {
      const slug = slugify(String(value));
      const clash = get<{ id: string }>('SELECT id FROM tenant WHERE slug = ? AND id <> ?', slug, tenantId);
      if (clash) throw new ValidationError({ slug: 'Auðkennið er þegar í notkun.' });
      value = slug;
    }

    sets.push(`${column} = ?`);
    params.push(value as string | number | null);
  }

  if (sets.length === 0) return tenant;

  sets.push('updated_at = ?');
  params.push(Date.now());
  params.push(tenantId);

  run(`UPDATE tenant SET ${sets.join(', ')} WHERE id = ?`, ...params);
  return getTenantOrThrow(tenantId);
}

export function deleteTenant(tenantId: string): void {
  run('DELETE FROM tenant WHERE id = ?', tenantId);
  logger.warn('Viðskiptavini eytt', { tenantId });
}

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

export interface FeatureState {
  enabled: boolean;
  config: Record<string, unknown>;
}

export function getFeatures(tenantId: string): Record<Feature, FeatureState> {
  const rows = all<{ feature: string; enabled: number; config: string }>(
    'SELECT feature, enabled, config FROM tenant_feature WHERE tenant_id = ?',
    tenantId,
  );
  const byKey = new Map(rows.map((r) => [r.feature, r]));

  const out = {} as Record<Feature, FeatureState>;
  for (const feature of FEATURES) {
    const row = byKey.get(feature);
    out[feature] = {
      enabled: row?.enabled === 1,
      config: fromJson<Record<string, unknown>>(row?.config, {}),
    };
  }
  return out;
}

export function isFeatureEnabled(tenantId: string, feature: Feature): boolean {
  const row = get<{ enabled: number }>(
    'SELECT enabled FROM tenant_feature WHERE tenant_id = ? AND feature = ?',
    tenantId,
    feature,
  );
  return row?.enabled === 1;
}

export function setFeature(tenantId: string, feature: Feature, enabled: boolean, featureConfig?: Record<string, unknown>): void {
  run(
    `INSERT INTO tenant_feature (tenant_id, feature, enabled, config, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id, feature) DO UPDATE SET
       enabled = excluded.enabled,
       config = CASE WHEN excluded.config = '{}' THEN tenant_feature.config ELSE excluded.config END,
       updated_at = excluded.updated_at`,
    tenantId,
    feature,
    enabled,
    toJson(featureConfig ?? {}),
    Date.now(),
  );
}

/** Replaces the full feature set — used by the onboarding wizard's checkboxes. */
export function setFeatures(tenantId: string, enabled: readonly Feature[]): void {
  const wanted = new Set(enabled);
  transaction(() => {
    for (const feature of FEATURES) {
      setFeature(tenantId, feature, wanted.has(feature));
    }
  });
  logger.info('Eiginleikar uppfærðir', { tenantId, features: [...wanted] });
}

/** Formats a tenant's address on one line for websites and calendar events. */
export function formatAddress(tenant: Tenant): string {
  const parts = [tenant.address, [tenant.postcode, tenant.city].filter(Boolean).join(' ')].filter(Boolean);
  return parts.join(', ');
}

export function tenantKennitalaDisplay(tenant: Tenant): string {
  return tenant.kennitala ? formatKennitala(tenant.kennitala) : '';
}
