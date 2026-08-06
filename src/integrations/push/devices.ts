/**
 * Device pairing for the owner's phone app.
 *
 * Pairing avoids giving every small-business owner a login to this control
 * plane. The operator generates a short code in the admin console, the owner
 * types it into the app once, and the app receives a long-lived device token
 * scoped to that single tenant. Nothing else in the platform is reachable
 * with it.
 */

import { all, get, run } from '../../core/db.ts';
import { hashToken } from '../../core/crypto.ts';
import { AppError, notFound } from '../../core/errors.ts';
import { id, pairingCode, token } from '../../core/ids.ts';
import { logger } from '../../core/logger.ts';

export type Platform = 'ios' | 'android' | 'vefur';

export interface Device {
  id: string;
  tenantId: string;
  label: string;
  platform: Platform;
  pushToken: string;
  pairedAt: number | null;
  lastSeenAt: number | null;
  active: boolean;
}

interface DeviceRow {
  id: string; tenant_id: string; label: string; platform: string; push_token: string;
  pairing_code: string | null; pairing_expires_at: number | null;
  paired_at: number | null; last_seen_at: number | null; active: number; created_at: number;
}

function toDevice(row: DeviceRow): Device {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    label: row.label,
    platform: row.platform as Platform,
    pushToken: row.push_token,
    pairedAt: row.paired_at,
    lastSeenAt: row.last_seen_at,
    active: row.active === 1,
  };
}

/** Codes are short enough to dictate over the phone, so they expire quickly. */
const PAIRING_TTL_MS = 30 * 60_000;

export interface PairingInvite {
  code: string;
  expiresAt: number;
  deviceId: string;
}

export function createPairingInvite(tenantId: string, label = 'Nýtt tæki'): PairingInvite {
  // Clear any unclaimed invite so a tenant never has two live codes.
  run('DELETE FROM device WHERE tenant_id = ? AND paired_at IS NULL', tenantId);

  const deviceId = id('tki');
  const code = pairingCode(6);
  const expiresAt = Date.now() + PAIRING_TTL_MS;

  run(
    `INSERT INTO device (id, tenant_id, label, platform, push_token, pairing_code, pairing_expires_at, active, created_at)
     VALUES (?,?,?,'ios','',?,?,1,?)`,
    deviceId,
    tenantId,
    label,
    code,
    expiresAt,
    Date.now(),
  );

  logger.info('Pörunarkóði búinn til', { tenantId, deviceId });
  return { code, expiresAt, deviceId };
}

export interface PairResult {
  deviceId: string;
  /** Bearer token the app stores and sends on every request. */
  deviceToken: string;
  tenantId: string;
  tenantName: string;
}

/**
 * Claims a pairing code. Returns a bearer token; only its HMAC is stored, in
 * the same way session cookies are handled.
 */
export function claimPairingCode(code: string, input: { pushToken: string; platform: Platform; label?: string }): PairResult {
  const normalized = code.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');

  const row = get<DeviceRow & { tenant_name: string }>(
    `SELECT d.*, t.name AS tenant_name FROM device d JOIN tenant t ON t.id = d.tenant_id
      WHERE d.pairing_code = ? AND d.paired_at IS NULL`,
    normalized,
  );

  if (!row) throw notFound('Pörunarkóðinn er ógildur eða þegar notaður.');
  if ((row.pairing_expires_at ?? 0) < Date.now()) {
    run('DELETE FROM device WHERE id = ?', row.id);
    throw new AppError(410, 'kodi_utrunninn', 'Pörunarkóðinn er útrunninn. Búðu til nýjan í stjórnborðinu.');
  }

  const deviceToken = token(32);

  run(
    `UPDATE device SET
       push_token = ?, platform = ?, label = ?, pairing_code = NULL, pairing_expires_at = NULL,
       paired_at = ?, last_seen_at = ?
     WHERE id = ?`,
    input.pushToken.trim(),
    input.platform,
    input.label?.trim() || row.label,
    Date.now(),
    Date.now(),
    row.id,
  );

  // The device token is stored in app_setting keyed by its hash, so the same
  // constant-time lookup as sessions applies.
  run(
    `INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    `device_token:${hashToken(deviceToken)}`,
    row.id,
    Date.now(),
  );

  logger.info('Tæki parað', { deviceId: row.id, tenantId: row.tenant_id, platform: input.platform });

  return {
    deviceId: row.id,
    deviceToken,
    tenantId: row.tenant_id,
    tenantName: row.tenant_name,
  };
}

/** Resolves a device bearer token to its device, updating last-seen. */
export function authenticateDevice(deviceToken: string | undefined): Device | null {
  if (!deviceToken) return null;

  const mapping = get<{ value: string }>('SELECT value FROM app_setting WHERE key = ?', `device_token:${hashToken(deviceToken)}`);
  if (!mapping) return null;

  const row = get<DeviceRow>('SELECT * FROM device WHERE id = ? AND active = 1', mapping.value);
  if (!row) return null;

  run('UPDATE device SET last_seen_at = ? WHERE id = ?', Date.now(), row.id);
  return toDevice(row);
}

export function listDevices(tenantId: string): Device[] {
  return all<DeviceRow>(
    'SELECT * FROM device WHERE tenant_id = ? AND paired_at IS NOT NULL ORDER BY last_seen_at DESC',
    tenantId,
  ).map(toDevice);
}

/** Devices with a usable push token, for fan-out. */
export function pushTargets(tenantId: string): Device[] {
  return all<DeviceRow>(
    "SELECT * FROM device WHERE tenant_id = ? AND active = 1 AND push_token <> ''",
    tenantId,
  ).map(toDevice);
}

export function pendingInvite(tenantId: string): { code: string; expiresAt: number } | null {
  const row = get<DeviceRow>(
    'SELECT * FROM device WHERE tenant_id = ? AND paired_at IS NULL AND pairing_expires_at > ?',
    tenantId,
    Date.now(),
  );
  return row?.pairing_code ? { code: row.pairing_code, expiresAt: row.pairing_expires_at ?? 0 } : null;
}

export function removeDevice(deviceId: string): void {
  run('DELETE FROM app_setting WHERE value = ? AND key LIKE ?', deviceId, 'device_token:%');
  run('DELETE FROM device WHERE id = ?', deviceId);
  logger.info('Tæki fjarlægt', { deviceId });
}

/** Marks a device inactive after the push service reports it unregistered. */
export function deactivateDevice(deviceId: string, reason: string): void {
  run('UPDATE device SET active = 0 WHERE id = ?', deviceId);
  logger.warn('Tæki gert óvirkt', { deviceId, reason });
}
