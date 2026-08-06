/**
 * Single-operator authentication.
 *
 * The platform has exactly one human user. That makes the security model
 * simple but raises the stakes: this one account can read every tenant's
 * calendar and mailbox. So the login path is deliberately conservative —
 * scrypt hashing, opaque session ids stored only as HMACs, per-IP and
 * per-account throttling, and CSRF tokens bound to the session.
 */

import { all, get, run, transaction } from '../core/db.ts';
import { hashPassword, hashToken, verifyPassword } from '../core/crypto.ts';
import { AppError, tooManyRequests, unauthorized } from '../core/errors.ts';
import { ID_PREFIX, id, safeEqual, token } from '../core/ids.ts';
import { logger } from '../core/logger.ts';
import { config } from '../config.ts';
import type { OperatorSession } from '../http/context.ts';

export const SESSION_COOKIE = 'rth_session';

export interface OperatorRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  totp_secret: string | null;
  created_at: number;
  updated_at: number;
  last_login_at: number | null;
}

/** Throttling thresholds. Both windows must pass for a login to be attempted. */
const RATE_LIMIT = {
  windowMs: 15 * 60_000,
  maxPerIp: 10,
  maxPerAccount: 5,
} as const;

export function operatorCount(): number {
  const row = get<{ c: number }>('SELECT COUNT(*) AS c FROM operator');
  return row?.c ?? 0;
}

export function findOperatorByEmail(email: string): OperatorRow | null {
  return get<OperatorRow>('SELECT * FROM operator WHERE email = ?', email.trim().toLowerCase());
}

export function getOperator(operatorId: string): OperatorRow | null {
  return get<OperatorRow>('SELECT * FROM operator WHERE id = ?', operatorId);
}

/**
 * Creates the operator account. Refuses to create a second one — this is a
 * deliberate product constraint, not an oversight: the whole platform assumes
 * a single trusted principal.
 */
export async function createOperator(email: string, password: string, name = ''): Promise<OperatorRow> {
  const normalized = email.trim().toLowerCase();
  if (!normalized.includes('@')) {
    throw new AppError(422, 'ogilt_netfang', 'Netfang er ógilt.');
  }
  if (operatorCount() > 0) {
    throw new AppError(409, 'notandi_til', 'Stjórnandi er þegar til. Notaðu endursetningu lykilorðs í staðinn.');
  }

  const passwordHash = await hashPassword(password);
  const now = Date.now();
  const operatorId = id('opr');

  run(
    `INSERT INTO operator (id, email, name, password_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    operatorId,
    normalized,
    name,
    passwordHash,
    now,
    now,
  );

  logger.info('Stjórnandi stofnaður', { email: normalized });
  return getOperator(operatorId)!;
}

export async function changePassword(operatorId: string, currentPassword: string, newPassword: string): Promise<void> {
  const operator = getOperator(operatorId);
  if (!operator) throw unauthorized();

  if (!(await verifyPassword(currentPassword, operator.password_hash))) {
    throw new AppError(403, 'rangt_lykilord', 'Núverandi lykilorð er rangt.');
  }

  const hash = await hashPassword(newPassword);
  transaction(() => {
    run('UPDATE operator SET password_hash = ?, updated_at = ? WHERE id = ?', hash, Date.now(), operatorId);
    // Every other session is invalidated; the caller re-issues their own.
    run('DELETE FROM session WHERE operator_id = ?', operatorId);
  });
  logger.info('Lykilorði breytt', { operatorId });
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

function recentFailures(identifier: string, since: number): number {
  const row = get<{ c: number }>(
    'SELECT COUNT(*) AS c FROM login_attempt WHERE identifier = ? AND success = 0 AND created_at > ?',
    identifier,
    since,
  );
  return row?.c ?? 0;
}

function recordAttempt(identifier: string, success: boolean): void {
  run('INSERT INTO login_attempt (identifier, success, created_at) VALUES (?, ?, ?)', identifier, success, Date.now());
}

/** Drops attempt rows older than the window; called opportunistically. */
export function pruneLoginAttempts(): void {
  run('DELETE FROM login_attempt WHERE created_at < ?', Date.now() - RATE_LIMIT.windowMs * 4);
}

// ---------------------------------------------------------------------------
// Login / sessions
// ---------------------------------------------------------------------------

export interface LoginResult {
  /** Raw cookie value. Only ever returned here — the database stores its HMAC. */
  sessionToken: string;
  operator: OperatorRow;
  expiresAt: number;
}

export async function login(
  email: string,
  password: string,
  meta: { ip: string; userAgent: string },
): Promise<LoginResult> {
  const since = Date.now() - RATE_LIMIT.windowMs;
  const normalized = email.trim().toLowerCase();

  if (recentFailures(`ip:${meta.ip}`, since) >= RATE_LIMIT.maxPerIp) {
    logger.warn('Innskráning stöðvuð vegna of margra tilrauna', { ip: meta.ip });
    throw tooManyRequests('Of margar innskráningartilraunir. Reyndu aftur eftir 15 mínútur.');
  }
  if (recentFailures(`acct:${normalized}`, since) >= RATE_LIMIT.maxPerAccount) {
    throw tooManyRequests('Of margar innskráningartilraunir fyrir þennan reikning. Reyndu aftur eftir 15 mínútur.');
  }

  const operator = findOperatorByEmail(normalized);

  // Always run a hash comparison, even for unknown accounts, so response time
  // does not reveal whether the email exists.
  const stored = operator?.password_hash ?? 'scrypt$00$'.padEnd(140, '0');
  const ok = await verifyPassword(password, stored);

  if (!operator || !ok) {
    recordAttempt(`ip:${meta.ip}`, false);
    recordAttempt(`acct:${normalized}`, false);
    throw unauthorized('Netfang eða lykilorð er rangt.');
  }

  recordAttempt(`ip:${meta.ip}`, true);
  recordAttempt(`acct:${normalized}`, true);

  const rawToken = token(32);
  const expiresAt = Date.now() + config.operator.sessionTtlHours * 3_600_000;
  const csrfSecret = token(24);

  transaction(() => {
    run(
      `INSERT INTO session (id, operator_id, csrf_secret, created_at, expires_at, last_seen_at, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      hashToken(rawToken),
      operator.id,
      csrfSecret,
      Date.now(),
      expiresAt,
      Date.now(),
      meta.ip,
      meta.userAgent.slice(0, 300),
    );
    run('UPDATE operator SET last_login_at = ? WHERE id = ?', Date.now(), operator.id);
  });

  pruneSessions();
  logger.info('Innskráning tókst', { operatorId: operator.id, ip: meta.ip });
  return { sessionToken: rawToken, operator, expiresAt };
}

export function logout(sessionToken: string): void {
  run('DELETE FROM session WHERE id = ?', hashToken(sessionToken));
}

export function pruneSessions(): void {
  run('DELETE FROM session WHERE expires_at < ?', Date.now());
}

interface SessionRow {
  id: string;
  operator_id: string;
  csrf_secret: string;
  expires_at: number;
  email: string;
  name: string;
}

/** Resolves a cookie value to a live session, sliding its expiry forward. */
export function resolveSession(sessionToken: string | undefined): OperatorSession | null {
  if (!sessionToken) return null;

  const hashed = hashToken(sessionToken);
  const row = get<SessionRow>(
    `SELECT s.id, s.operator_id, s.csrf_secret, s.expires_at, o.email, o.name
       FROM session s JOIN operator o ON o.id = s.operator_id
      WHERE s.id = ?`,
    hashed,
  );

  if (!row) return null;
  if (row.expires_at < Date.now()) {
    run('DELETE FROM session WHERE id = ?', hashed);
    return null;
  }

  // Slide the session forward at most once a minute to avoid a write per request.
  const now = Date.now();
  run('UPDATE session SET last_seen_at = ? WHERE id = ? AND last_seen_at < ?', now, hashed, now - 60_000);

  return {
    sessionId: row.id,
    operatorId: row.operator_id,
    email: row.email,
    name: row.name,
    csrfToken: csrfTokenFor(row.csrf_secret),
  };
}

export function listSessions(operatorId: string): Array<{ id: string; ip: string; user_agent: string; created_at: number; last_seen_at: number }> {
  return all(
    'SELECT id, ip, user_agent, created_at, last_seen_at FROM session WHERE operator_id = ? ORDER BY last_seen_at DESC',
    operatorId,
  );
}

export function revokeSession(operatorId: string, sessionId: string): void {
  run('DELETE FROM session WHERE id = ? AND operator_id = ?', sessionId, operatorId);
}

// ---------------------------------------------------------------------------
// CSRF
// ---------------------------------------------------------------------------

/**
 * The token is derived from a per-session secret rather than stored, so it is
 * stable for the session's lifetime and cannot be replayed across sessions.
 */
function csrfTokenFor(secret: string): string {
  return hashToken(`csrf:${secret}`).slice(0, 43);
}

export function verifyCsrf(session: OperatorSession | null, submitted: string | undefined): boolean {
  if (!session || !submitted) return false;
  return safeEqual(session.csrfToken, submitted);
}
