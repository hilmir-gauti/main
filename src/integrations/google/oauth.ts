/**
 * Google OAuth 2.0 for per-tenant Calendar access.
 *
 * Each tenant links their own Google account, so bookings land in the calendar
 * the business already lives in. Refresh tokens are encrypted at rest and
 * access tokens are refreshed lazily, a minute before they actually expire.
 */

import { get, run } from '../../core/db.ts';
import { open, seal, signValue, unsignValue } from '../../core/crypto.ts';
import { AppError, IntegrationError, badRequest } from '../../core/errors.ts';
import { id } from '../../core/ids.ts';
import { logger } from '../../core/logger.ts';
import { config } from '../../config.ts';
import { requestJson } from '../http.ts';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/userinfo';

/**
 * `calendar.events` covers reading and writing appointments;
 * `calendar.readonly` is needed to enumerate which calendars exist so the
 * operator can pick one.
 */
export const CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
  'openid',
  'email',
] as const;

export interface OAuthAccount {
  id: string;
  tenantId: string | null;
  provider: string;
  accountEmail: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number | null;
  scope: string;
  calendarId: string;
  lastSyncAt: number | null;
  lastError: string;
}

interface AccountRow {
  id: string; tenant_id: string | null; provider: string; account_email: string;
  subject: string; access_token: string; refresh_token: string; expires_at: number | null;
  scope: string; calendar_id: string; last_sync_at: number | null; last_error: string;
}

function toAccount(row: AccountRow): OAuthAccount {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    provider: row.provider,
    accountEmail: row.account_email,
    accessToken: open(row.access_token) ?? '',
    refreshToken: open(row.refresh_token) ?? '',
    expiresAt: row.expires_at,
    scope: row.scope,
    calendarId: row.calendar_id || 'primary',
    lastSyncAt: row.last_sync_at,
    lastError: row.last_error,
  };
}

export function getGoogleAccount(tenantId: string): OAuthAccount | null {
  const row = get<AccountRow>(
    "SELECT * FROM oauth_account WHERE tenant_id = ? AND provider = 'google'",
    tenantId,
  );
  return row ? toAccount(row) : null;
}

export function isCalendarLinked(tenantId: string): boolean {
  const account = getGoogleAccount(tenantId);
  return Boolean(account?.refreshToken);
}

/**
 * Builds the consent URL.
 *
 * `access_type=offline` + `prompt=consent` guarantees a refresh token even when
 * the user has authorised this app before — without it, a re-link produces an
 * access token only and the integration silently dies an hour later.
 */
export function buildAuthUrl(tenantId: string): string {
  if (!config.google.enabled) {
    throw new AppError(503, 'google_ostillt', 'Google-tenging er ekki uppsett. Bættu við GOOGLE_CLIENT_ID og GOOGLE_CLIENT_SECRET.');
  }

  const params = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: config.google.redirectUri,
    response_type: 'code',
    scope: CALENDAR_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    // Signed so a forged callback cannot bind someone else's Google account
    // to one of our tenants.
    state: signValue(`${tenantId}:${Date.now()}`),
  });

  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

/** Validates the signed `state` and returns the tenant it belongs to. */
export function parseState(state: string): string {
  const value = unsignValue(state);
  if (!value) throw badRequest('Öryggisauðkenni í svari frá Google er ógilt.');

  const [tenantId, issuedAt] = value.split(':');
  if (!tenantId || !issuedAt) throw badRequest('Öryggisauðkenni í svari frá Google er ógilt.');

  // A consent flow that takes more than 30 minutes is a replay, not a slow user.
  if (Date.now() - Number(issuedAt) > 30 * 60_000) {
    throw badRequest('Tengingin rann út. Reyndu að tengja dagatalið aftur.');
  }
  return tenantId;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

export async function exchangeCode(code: string): Promise<TokenResponse> {
  const { data } = await requestJson<TokenResponse>('google-oauth', TOKEN_ENDPOINT, {
    method: 'POST',
    body: new URLSearchParams({
      code,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      redirect_uri: config.google.redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  if (!data?.access_token) {
    throw new IntegrationError('google-oauth', 'Ekkert access_token í svari.');
  }
  return data;
}

async function fetchAccountEmail(accessToken: string): Promise<string> {
  try {
    const { data } = await requestJson<{ email?: string }>('google-oauth', USERINFO_ENDPOINT, {
      headers: { authorization: `Bearer ${accessToken}` },
      retries: 2,
    });
    return data?.email ?? '';
  } catch (error) {
    // Not fatal — the calendar still works, we just cannot label the account.
    logger.warn('Náði ekki netfangi Google-reiknings', { error });
    return '';
  }
}

/** Persists (or re-links) a tenant's Google account. */
export async function saveGoogleAccount(tenantId: string, tokens: TokenResponse): Promise<OAuthAccount> {
  const email = await fetchAccountEmail(tokens.access_token);
  const now = Date.now();
  const expiresAt = now + tokens.expires_in * 1000;

  const existing = getGoogleAccount(tenantId);

  if (existing) {
    run(
      `UPDATE oauth_account SET
         account_email = ?, access_token = ?,
         refresh_token = CASE WHEN ? <> '' THEN ? ELSE refresh_token END,
         expires_at = ?, scope = ?, last_error = '', updated_at = ?
       WHERE id = ?`,
      email || existing.accountEmail,
      seal(tokens.access_token),
      // Google omits refresh_token on re-consent in some flows; keep the old one.
      tokens.refresh_token ?? '',
      tokens.refresh_token ? seal(tokens.refresh_token) : '',
      expiresAt,
      tokens.scope,
      now,
      existing.id,
    );
  } else {
    run(
      `INSERT INTO oauth_account (
         id, tenant_id, provider, account_email, subject, access_token, refresh_token,
         expires_at, scope, calendar_id, created_at, updated_at
       ) VALUES (?,?,'google',?,'',?,?,?,?,'primary',?,?)`,
      id('oau'),
      tenantId,
      email,
      seal(tokens.access_token),
      seal(tokens.refresh_token ?? ''),
      expiresAt,
      tokens.scope,
      now,
      now,
    );
  }

  logger.info('Google-dagatal tengt', { tenantId, email });
  return getGoogleAccount(tenantId)!;
}

export function unlinkGoogleAccount(tenantId: string): void {
  run("DELETE FROM oauth_account WHERE tenant_id = ? AND provider = 'google'", tenantId);
  run("DELETE FROM external_busy WHERE tenant_id = ? AND source = 'google'", tenantId);
  logger.info('Google-dagatal aftengt', { tenantId });
}

export function setCalendarId(tenantId: string, calendarId: string): void {
  run(
    "UPDATE oauth_account SET calendar_id = ?, updated_at = ? WHERE tenant_id = ? AND provider = 'google'",
    calendarId,
    Date.now(),
    tenantId,
  );
}

export function recordSyncResult(tenantId: string, error?: string): void {
  run(
    "UPDATE oauth_account SET last_sync_at = ?, last_error = ? WHERE tenant_id = ? AND provider = 'google'",
    Date.now(),
    error?.slice(0, 500) ?? '',
    tenantId,
  );
}

/** Refresh a minute early, so a token cannot expire mid-request. */
const EXPIRY_SKEW_MS = 60_000;

/**
 * Returns a valid access token, refreshing it if needed.
 *
 * Throws a 409 when the refresh token has been revoked, because that needs
 * operator action (re-linking) rather than a retry.
 */
export async function getAccessToken(tenantId: string): Promise<string> {
  const account = getGoogleAccount(tenantId);
  if (!account) {
    throw new AppError(409, 'dagatal_otengt', 'Google-dagatal er ekki tengt fyrir þennan viðskiptavin.');
  }

  if (account.accessToken && account.expiresAt && account.expiresAt - EXPIRY_SKEW_MS > Date.now()) {
    return account.accessToken;
  }

  if (!account.refreshToken) {
    throw new AppError(409, 'dagatal_otengt', 'Google-tengingin er útrunnin. Tengdu dagatalið aftur.');
  }

  const { data, status } = await requestJson<TokenResponse & { error?: string; error_description?: string }>(
    'google-oauth',
    TOKEN_ENDPOINT,
    {
      method: 'POST',
      body: new URLSearchParams({
        refresh_token: account.refreshToken,
        client_id: config.google.clientId,
        client_secret: config.google.clientSecret,
        grant_type: 'refresh_token',
      }),
      tolerate: [400, 401],
    },
  );

  if (status === 400 || status === 401 || !data?.access_token) {
    const reason = data?.error_description ?? data?.error ?? 'óþekkt';
    recordSyncResult(tenantId, `Endurnýjun aðgangs mistókst: ${reason}`);
    logger.warn('Google refresh token hafnað', { tenantId, reason });
    throw new AppError(
      409,
      'dagatal_otengt',
      'Google-tengingin er ekki lengur virk. Tengdu dagatalið aftur í stillingum.',
    );
  }

  run(
    "UPDATE oauth_account SET access_token = ?, expires_at = ?, last_error = '', updated_at = ? WHERE id = ?",
    seal(data.access_token),
    Date.now() + data.expires_in * 1000,
    Date.now(),
    account.id,
  );

  return data.access_token;
}
