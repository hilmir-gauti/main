/**
 * Outbound email.
 *
 * Every message is written to `message_log` before it is attempted, so the
 * operator can always answer "did the confirmation actually go out?" — the
 * single most common support question a booking system generates.
 *
 * When no SMTP credentials exist the mailer runs in *þurrkeyrsla* (dry-run):
 * the message is rendered and logged with status `thurrkeyrsla` but not sent.
 * That keeps the whole platform usable before any mailbox exists, and makes
 * the test suite hermetic.
 *
 * Per-tenant SMTP is supported so a salon's confirmations come from
 * `bokanir@stofan.is` rather than from the platform.
 */

import { all, get, run } from '../../core/db.ts';
import { open, seal } from '../../core/crypto.ts';
import { isValidEmail } from '../../core/iceland.ts';
import { id } from '../../core/ids.ts';
import { logger } from '../../core/logger.ts';
import { config } from '../../config.ts';
import { getFeatures, getTenant } from '../../domain/tenants.ts';
import { sendSmtpMail, type MailAddress, type SmtpConfig } from './smtp.ts';

export type MessageStatus = 'bidur' | 'sent' | 'villa' | 'thurrkeyrsla';

export interface SendMailInput {
  tenantId?: string | null;
  to: string | MailAddress;
  subject: string;
  text: string;
  html?: string;
  /** Template name, recorded for filtering the log. */
  template?: string;
  relatedBookingId?: string | null;
  replyTo?: MailAddress;
}

export interface SendMailResult {
  id: string;
  status: MessageStatus;
  error?: string;
}

interface ResolvedSender {
  smtp: SmtpConfig | null;
  from: MailAddress;
}

/**
 * Tenant SMTP settings live in the `tolvupostur` feature config. The password
 * is sealed with the app key before it is written, so the JSON column never
 * holds a usable credential.
 */
export interface TenantSmtpSettings {
  host: string;
  port: number;
  user: string;
  password: string;
  implicitTls?: boolean;
  fromEmail: string;
  fromName?: string;
}

export function saveTenantSmtp(tenantId: string, settings: TenantSmtpSettings): void {
  const stored = {
    smtpHost: settings.host,
    smtpPort: settings.port,
    smtpUser: settings.user,
    smtpPasswordSealed: seal(settings.password),
    smtpImplicitTls: settings.implicitTls ?? settings.port === 465,
    fromEmail: settings.fromEmail,
    fromName: settings.fromName ?? '',
  };

  run(
    `INSERT INTO tenant_feature (tenant_id, feature, enabled, config, updated_at)
     VALUES (?, 'tolvupostur', 1, ?, ?)
     ON CONFLICT(tenant_id, feature) DO UPDATE SET enabled = 1, config = excluded.config, updated_at = excluded.updated_at`,
    tenantId,
    JSON.stringify(stored),
    Date.now(),
  );
  logger.info('SMTP-stillingar vistaðar fyrir viðskiptavin', { tenantId, host: settings.host });
}

function resolveSender(tenantId: string | null | undefined): ResolvedSender {
  const tenant = tenantId ? getTenant(tenantId) : null;

  if (tenant) {
    const settings = getFeatures(tenant.id).tolvupostur.config as Record<string, unknown>;
    const host = String(settings.smtpHost ?? '');
    const fromEmail = String(settings.fromEmail ?? '');

    if (host && fromEmail) {
      const password = open(String(settings.smtpPasswordSealed ?? '')) ?? '';
      return {
        smtp: {
          host,
          port: Number(settings.smtpPort ?? 587),
          user: String(settings.smtpUser ?? ''),
          password,
          implicitTls: settings.smtpImplicitTls === true,
        },
        from: { name: String(settings.fromName || tenant.name), email: fromEmail },
      };
    }
  }

  // Fall back to the platform mailbox, but keep the tenant's name on the
  // envelope so the customer recognises the sender.
  const from: MailAddress = {
    name: tenant?.name || config.smtp.fromName,
    email: config.smtp.fromEmail,
  };

  if (!config.smtp.enabled) return { smtp: null, from };

  return {
    smtp: {
      host: config.smtp.host,
      port: config.smtp.port,
      user: config.smtp.user,
      password: config.smtp.password,
      implicitTls: config.smtp.implicitTls,
    },
    from,
  };
}

export async function sendMail(input: SendMailInput): Promise<SendMailResult> {
  const recipient: MailAddress = typeof input.to === 'string' ? { email: input.to } : input.to;

  const messageId = id('msg');
  const now = Date.now();

  if (!recipient.email || !isValidEmail(recipient.email)) {
    logMessage(messageId, input, recipient, 'villa', now, 'Ógilt netfang viðtakanda');
    return { id: messageId, status: 'villa', error: 'Ógilt netfang viðtakanda' };
  }

  const { smtp, from } = resolveSender(input.tenantId);

  if (!smtp || !from.email) {
    logMessage(messageId, input, recipient, 'thurrkeyrsla', now, '');
    logger.info('Tölvupóstur í þurrkeyrslu (SMTP óstillt)', {
      to: recipient.email,
      subject: input.subject,
      template: input.template,
    });
    return { id: messageId, status: 'thurrkeyrsla' };
  }

  logMessage(messageId, input, recipient, 'bidur', now, '', from.email);

  try {
    const result = await sendSmtpMail(smtp, {
      from,
      to: [recipient],
      replyTo: input.replyTo,
      subject: input.subject,
      text: input.text,
      html: input.html,
      headers: {
        'X-Rafraen-Template': input.template ?? 'almennt',
        // Transactional mail should not generate auto-replies or bounces loops.
        'Auto-Submitted': 'auto-generated',
      },
    });

    run(
      "UPDATE message_log SET status = 'sent', sent_at = ?, provider = ?, provider_id = ? WHERE id = ?",
      Date.now(),
      smtp.host,
      result.messageId,
      messageId,
    );

    logger.info('Tölvupóstur sendur', { to: recipient.email, subject: input.subject, template: input.template });
    return { id: messageId, status: 'sent' };
  } catch (error) {
    // Never let an empty message through: the console shows this text, and a
    // blank failure reason is the one thing an operator cannot act on.
    const raw = error instanceof Error ? error.message : String(error);
    const message = raw.trim() || `Tengingin við ${smtp.host}:${smtp.port} slitnaði án skýringar.`;
    run("UPDATE message_log SET status = 'villa', error = ? WHERE id = ?", message.slice(0, 500), messageId);
    logger.error('Sending tölvupósts mistókst', { to: recipient.email, error: message });
    return { id: messageId, status: 'villa', error: message };
  }
}

function logMessage(
  messageId: string,
  input: SendMailInput,
  recipient: MailAddress,
  status: MessageStatus,
  now: number,
  error: string,
  fromAddress = '',
): void {
  run(
    `INSERT INTO message_log (
       id, tenant_id, channel, direction, to_addr, from_addr, subject, body,
       template, status, provider, error, related_booking_id, created_at, sent_at
     ) VALUES (?,?,'tolvupostur','ut',?,?,?,?,?,?,'',?,?,?,?)`,
    messageId,
    input.tenantId ?? null,
    recipient.email,
    fromAddress,
    input.subject.slice(0, 300),
    input.text.slice(0, 4000),
    input.template ?? '',
    status,
    error,
    input.relatedBookingId ?? null,
    now,
    status === 'thurrkeyrsla' ? now : null,
  );
}

// ---------------------------------------------------------------------------
// Log queries (admin console)
// ---------------------------------------------------------------------------

export interface MessageLogEntry {
  id: string;
  tenant_id: string | null;
  channel: string;
  to_addr: string;
  subject: string;
  template: string;
  status: MessageStatus;
  error: string;
  created_at: number;
  sent_at: number | null;
}

export function listMessages(options: { tenantId?: string; limit?: number; status?: MessageStatus } = {}): MessageLogEntry[] {
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

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(Math.min(options.limit ?? 100, 500));

  return all<MessageLogEntry>(
    `SELECT id, tenant_id, channel, to_addr, subject, template, status, error, created_at, sent_at
       FROM message_log ${where} ORDER BY created_at DESC LIMIT ?`,
    ...params,
  );
}

export function messageStats(tenantId?: string): { sent: number; failed: number; dryRun: number } {
  const where = tenantId ? 'WHERE tenant_id = ?' : '';
  const params = tenantId ? [tenantId] : [];
  const row = get<{ sent: number; failed: number; dry: number }>(
    `SELECT
       SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
       SUM(CASE WHEN status = 'villa' THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN status = 'thurrkeyrsla' THEN 1 ELSE 0 END) AS dry
     FROM message_log ${where}`,
    ...params,
  );
  return { sent: row?.sent ?? 0, failed: row?.failed ?? 0, dryRun: row?.dry ?? 0 };
}

/**
 * Verifies SMTP credentials by sending a test message to the operator.
 * Used by the "prófa tengingu" button in tenant settings.
 */
export async function testSmtpConnection(tenantId: string | null, testRecipient: string): Promise<SendMailResult> {
  return sendMail({
    tenantId,
    to: testRecipient,
    subject: 'Prófun á tölvupóstsuppsetningu',
    text: [
      'Þetta er prófunarpóstur frá Rafrænni Þjónustu.',
      '',
      'Ef þú færð þennan póst þá er uppsetningin rétt og staðfestingarpóstar munu skila sér.',
    ].join('\n'),
    template: 'profun',
  });
}
