/**
 * Twilio client: SMS sending, webhook signature verification and number lookup.
 *
 * Signature verification matters more here than in most integrations: the
 * voice webhook can create bookings, so an unverified endpoint would let
 * anyone on the internet fill a salon's diary with fake appointments.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import { run } from '../core/db.ts';
import { IntegrationError } from '../core/errors.ts';
import { canReceiveSms, normalizePhone } from '../core/iceland.ts';
import { id } from '../core/ids.ts';
import { logger } from '../core/logger.ts';
import { config } from '../config.ts';
import { getTenant } from '../domain/tenants.ts';
import { requestJson } from './http.ts';

const API_BASE = 'https://api.twilio.com/2010-04-01';

function authHeader(): string {
  const credentials = Buffer.from(`${config.twilio.accountSid}:${config.twilio.authToken}`, 'utf8').toString('base64');
  return `Basic ${credentials}`;
}

// ---------------------------------------------------------------------------
// Webhook signature verification
// ---------------------------------------------------------------------------

/**
 * Twilio signs each webhook with HMAC-SHA1 over the full request URL followed
 * by every POST parameter, sorted by name and concatenated as key+value with
 * no separators.
 *
 * The URL must be exactly what Twilio called, including scheme and any query
 * string — behind a proxy that means reconstructing it from BASE_URL rather
 * than from the Host header, which is why the caller passes it in.
 */
export function verifyTwilioSignature(url: string, params: Record<string, string>, signature: string | undefined): boolean {
  if (!config.twilio.validateSignature) return true;
  if (!signature || !config.twilio.authToken) return false;

  const payload = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);

  const expected = createHmac('sha1', config.twilio.authToken).update(Buffer.from(payload, 'utf8')).digest('base64');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Flattens a parsed form body to the string map the signature check needs. */
export function formParams(body: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    if (Array.isArray(value)) out[key] = String(value[value.length - 1] ?? '');
    else if (value !== undefined && value !== null) out[key] = String(value);
  }
  return out;
}

// ---------------------------------------------------------------------------
// SMS
// ---------------------------------------------------------------------------

export interface SmsResult {
  id: string;
  status: 'sent' | 'villa' | 'thurrkeyrsla';
  error?: string;
}

/**
 * Sends an SMS, logging it either way.
 *
 * Icelandic landlines cannot receive SMS, so those are rejected up front
 * rather than paying Twilio for a message that will silently vanish.
 */
export async function sendSms(input: {
  tenantId?: string | null;
  to: string;
  body: string;
  relatedBookingId?: string | null;
  template?: string;
}): Promise<SmsResult> {
  const messageId = id('msg');
  const phone = normalizePhone(input.to);
  const now = Date.now();

  const logSms = (status: string, error: string, sentAt: number | null = null) => {
    run(
      `INSERT INTO message_log (
         id, tenant_id, channel, direction, to_addr, from_addr, subject, body,
         template, status, provider, error, related_booking_id, created_at, sent_at
       ) VALUES (?,?,'sms','ut',?,?,'',?,?,?,'twilio',?,?,?,?)`,
      messageId,
      input.tenantId ?? null,
      phone.valid ? phone.e164 : input.to,
      config.twilio.phoneNumber,
      input.body.slice(0, 1600),
      input.template ?? '',
      status,
      error,
      input.relatedBookingId ?? null,
      now,
      sentAt,
    );
  };

  if (!phone.valid) {
    logSms('villa', 'Ógilt símanúmer');
    return { id: messageId, status: 'villa', error: 'Ógilt símanúmer' };
  }
  if (!canReceiveSms(phone.e164)) {
    logSms('villa', 'Númerið getur ekki tekið við SMS (heimasími)');
    return { id: messageId, status: 'villa', error: 'Númerið getur ekki tekið við SMS' };
  }

  if (!config.twilio.enabled || !config.twilio.phoneNumber) {
    logSms('thurrkeyrsla', '', now);
    logger.info('SMS í þurrkeyrslu (Twilio óstillt)', { to: phone.e164, body: input.body.slice(0, 80) });
    return { id: messageId, status: 'thurrkeyrsla' };
  }

  logSms('bidur', '');

  try {
    const { data } = await requestJson<{ sid: string; status: string }>(
      'twilio-sms',
      `${API_BASE}/Accounts/${config.twilio.accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: { authorization: authHeader() },
        body: new URLSearchParams({
          To: phone.e164,
          From: config.twilio.phoneNumber,
          Body: input.body,
        }),
      },
    );

    run("UPDATE message_log SET status = 'sent', sent_at = ?, provider_id = ? WHERE id = ?", Date.now(), data?.sid ?? '', messageId);
    logger.info('SMS sent', { to: phone.e164, sid: data?.sid });
    return { id: messageId, status: 'sent' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    run("UPDATE message_log SET status = 'villa', error = ? WHERE id = ?", message.slice(0, 500), messageId);
    logger.error('SMS-sending mistókst', { to: phone.e164, error: message });
    return { id: messageId, status: 'villa', error: message };
  }
}

// ---------------------------------------------------------------------------
// Phone numbers
// ---------------------------------------------------------------------------

export interface AvailableNumber {
  phoneNumber: string;
  friendlyName: string;
  locality: string;
  capabilities: { voice: boolean; sms: boolean };
}

/**
 * Searches for purchasable numbers. Iceland's country code is IS; Twilio's
 * Icelandic inventory is mostly national (non-geographic) numbers.
 */
export async function searchNumbers(countryCode = 'IS', options: { areaCode?: string; contains?: string } = {}): Promise<AvailableNumber[]> {
  if (!config.twilio.enabled) return [];

  const params = new URLSearchParams({ VoiceEnabled: 'true', SmsEnabled: 'true', PageSize: '20' });
  if (options.areaCode) params.set('AreaCode', options.areaCode);
  if (options.contains) params.set('Contains', options.contains);

  const { data } = await requestJson<{ available_phone_numbers?: Array<{ phone_number: string; friendly_name: string; locality: string; capabilities: Record<string, boolean> }> }>(
    'twilio-numbers',
    `${API_BASE}/Accounts/${config.twilio.accountSid}/AvailablePhoneNumbers/${countryCode}/Local.json?${params.toString()}`,
    { headers: { authorization: authHeader() }, tolerate: [404] },
  );

  return (data?.available_phone_numbers ?? []).map((entry) => ({
    phoneNumber: entry.phone_number,
    friendlyName: entry.friendly_name,
    locality: entry.locality ?? '',
    capabilities: { voice: entry.capabilities?.voice === true, sms: entry.capabilities?.SMS === true || entry.capabilities?.sms === true },
  }));
}

/**
 * Buys a number and points its voice webhook at this platform.
 *
 * The tenant id is carried in the webhook path rather than looked up from the
 * dialled number, so a tenant that later ports in their existing number only
 * has to change one URL.
 */
export async function purchaseNumber(tenantId: string, phoneNumber: string): Promise<{ sid: string; phoneNumber: string }> {
  const tenant = getTenant(tenantId);
  if (!tenant) throw new IntegrationError('twilio', `Óþekktur viðskiptavinur ${tenantId}`);

  if (!config.twilio.enabled) {
    throw new IntegrationError('twilio', 'Twilio er ekki uppsett — bættu við TWILIO_ACCOUNT_SID og TWILIO_AUTH_TOKEN.');
  }

  const { data } = await requestJson<{ sid: string; phone_number: string }>(
    'twilio-numbers',
    `${API_BASE}/Accounts/${config.twilio.accountSid}/IncomingPhoneNumbers.json`,
    {
      method: 'POST',
      headers: { authorization: authHeader() },
      body: new URLSearchParams({
        PhoneNumber: phoneNumber,
        FriendlyName: tenant.name,
        VoiceUrl: `${config.baseUrl}/simi/${tenantId}/svara`,
        VoiceMethod: 'POST',
        StatusCallback: `${config.baseUrl}/simi/${tenantId}/stada`,
        StatusCallbackMethod: 'POST',
        SmsUrl: `${config.baseUrl}/simi/${tenantId}/sms`,
        SmsMethod: 'POST',
      }),
    },
  );

  logger.info('Símanúmer keypt', { tenantId, phoneNumber: data?.phone_number });
  return { sid: data?.sid ?? '', phoneNumber: data?.phone_number ?? phoneNumber };
}

/** The webhook URLs an operator must paste into the Twilio console manually. */
export function webhookUrls(tenantId: string): { voice: string; status: string; sms: string } {
  return {
    voice: `${config.baseUrl}/simi/${tenantId}/svara`,
    status: `${config.baseUrl}/simi/${tenantId}/stada`,
    sms: `${config.baseUrl}/simi/${tenantId}/sms`,
  };
}
