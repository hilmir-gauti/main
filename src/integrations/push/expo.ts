/**
 * Push notifications via Expo.
 *
 * Expo is used rather than APNs and FCM directly for one reason that matters
 * to a one-person operation: a single token format and a single HTTP endpoint
 * cover both iOS and Android, with no Apple certificate rotation to babysit.
 *
 * Every notification is recorded in the `notification` table first, so the
 * admin console can show what was sent and why a device stopped receiving.
 */

import { all, get, run, toJson } from '../../core/db.ts';
import { id } from '../../core/ids.ts';
import { logger } from '../../core/logger.ts';
import { config } from '../../config.ts';
import { requestJson } from '../http.ts';
import { deactivateDevice, pushTargets, type Device } from './devices.ts';

export interface PushMessage {
  tenantId: string;
  kind: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  /** Android notification channel; must match one created in the app. */
  channelId?: string;
  badge?: number;
}

export interface PushResult {
  attempted: number;
  sent: number;
  failed: number;
  dryRun: boolean;
}

interface ExpoTicket {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
}

/** Expo accepts at most 100 messages per request. */
const BATCH_SIZE = 100;

export async function sendPush(message: PushMessage): Promise<PushResult> {
  const devices = pushTargets(message.tenantId);

  if (devices.length === 0) {
    logger.debug('Engin pöruð tæki fyrir tilkynningu', { tenantId: message.tenantId, kind: message.kind });
    return { attempted: 0, sent: 0, failed: 0, dryRun: false };
  }

  const notificationIds = devices.map((device) => logNotification(message, device, config.push.enabled ? 'bidur' : 'thurrkeyrsla'));

  if (!config.push.enabled) {
    logger.info('Tilkynning í þurrkeyrslu (push slökkt)', { tenantId: message.tenantId, kind: message.kind, devices: devices.length });
    return { attempted: devices.length, sent: 0, failed: 0, dryRun: true };
  }

  let sent = 0;
  let failed = 0;

  for (let offset = 0; offset < devices.length; offset += BATCH_SIZE) {
    const batch = devices.slice(offset, offset + BATCH_SIZE);
    const payload = batch.map((device) => ({
      to: device.pushToken,
      title: message.title,
      body: message.body,
      data: { kind: message.kind, tenantId: message.tenantId, ...message.data },
      sound: 'default',
      // Booking alerts are time-sensitive; anything less and Android will
      // batch them into a digest the owner sees hours later.
      priority: 'high',
      channelId: message.channelId ?? 'bokanir',
      ...(message.badge !== undefined ? { badge: message.badge } : {}),
    }));

    try {
      const { data } = await requestJson<{ data?: ExpoTicket[]; errors?: unknown }>(
        'expo-push',
        config.push.expoEndpoint,
        {
          method: 'POST',
          headers: {
            ...(config.push.expoAccessToken ? { authorization: `Bearer ${config.push.expoAccessToken}` } : {}),
            'content-type': 'application/json',
          },
          body: JSON.stringify(payload),
        },
      );

      const tickets = data?.data ?? [];
      batch.forEach((device, index) => {
        const ticket = tickets[index];
        const notificationId = notificationIds[offset + index]!;

        if (ticket?.status === 'ok') {
          run("UPDATE notification SET status = 'sent', sent_at = ? WHERE id = ?", Date.now(), notificationId);
          sent++;
          return;
        }

        const errorCode = ticket?.details?.error ?? '';
        const reason = ticket?.message ?? 'Óþekkt villa frá Expo';
        run(
          "UPDATE notification SET status = 'villa', error = ?, attempts = attempts + 1 WHERE id = ?",
          `${errorCode} ${reason}`.trim().slice(0, 300),
          notificationId,
        );
        failed++;

        // The app was uninstalled or the token was rotated — stop trying.
        if (errorCode === 'DeviceNotRegistered') {
          deactivateDevice(device.id, 'Expo: DeviceNotRegistered');
        }
      });
    } catch (error) {
      const message_ = error instanceof Error ? error.message : String(error);
      for (let index = 0; index < batch.length; index++) {
        run(
          "UPDATE notification SET status = 'villa', error = ?, attempts = attempts + 1 WHERE id = ?",
          message_.slice(0, 300),
          notificationIds[offset + index]!,
        );
      }
      failed += batch.length;
      logger.error('Sending tilkynninga mistókst', { tenantId: message.tenantId, error: message_ });
    }
  }

  logger.info('Tilkynningar sendar', { tenantId: message.tenantId, kind: message.kind, sent, failed });
  return { attempted: devices.length, sent, failed, dryRun: false };
}

function logNotification(message: PushMessage, device: Device, status: string): string {
  const notificationId = id('tlk');
  run(
    `INSERT INTO notification (id, tenant_id, device_id, kind, title, body, data, status, attempts, created_at)
     VALUES (?,?,?,?,?,?,?,?,0,?)`,
    notificationId,
    message.tenantId,
    device.id,
    message.kind,
    message.title.slice(0, 200),
    message.body.slice(0, 500),
    toJson(message.data ?? {}),
    status,
    Date.now(),
  );
  return notificationId;
}

// ---------------------------------------------------------------------------
// Log queries
// ---------------------------------------------------------------------------

export interface NotificationEntry {
  id: string;
  kind: string;
  title: string;
  body: string;
  status: string;
  error: string;
  created_at: number;
  sent_at: number | null;
}

export function listNotifications(tenantId: string, limit = 50): NotificationEntry[] {
  return all<NotificationEntry>(
    `SELECT id, kind, title, body, status, error, created_at, sent_at
       FROM notification WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?`,
    tenantId,
    Math.min(limit, 200),
  );
}

export function notificationStats(tenantId: string): { sent: number; failed: number; pending: number } {
  const row = get<{ sent: number; failed: number; pending: number }>(
    `SELECT
       SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
       SUM(CASE WHEN status = 'villa' THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN status = 'bidur' THEN 1 ELSE 0 END) AS pending
     FROM notification WHERE tenant_id = ?`,
    tenantId,
  );
  return { sent: row?.sent ?? 0, failed: row?.failed ?? 0, pending: row?.pending ?? 0 };
}
