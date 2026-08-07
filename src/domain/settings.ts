/**
 * Integration credentials, stored in the database and editable in the console.
 *
 * The packaged desktop build has no `.env` file and no shell, so credentials
 * have to be enterable in the UI. They are kept in `app_setting`, with every
 * secret sealed with AES-256-GCM first — a stolen database file yields no
 * usable Google, Twilio or SMTP access without the app secret.
 *
 * Precedence is deliberate: a value typed into the console overrides the
 * environment. Someone who fills in a field expects it to take effect, not to
 * be silently outranked by a variable set months ago.
 */

import { all, run } from '../core/db.ts';
import { open, seal } from '../core/crypto.ts';
import { logger } from '../core/logger.ts';
import { setConfigOverrides } from '../config.ts';

const PREFIX = 'stilling:';

/** Values that are encrypted at rest and never echoed back to the browser. */
const SECRETS = new Set([
  'GOOGLE_CLIENT_SECRET',
  'SMTP_PASSWORD',
  'TWILIO_AUTH_TOKEN',
  'EXPO_ACCESS_TOKEN',
  'ANTHROPIC_API_KEY',
]);

/** Everything the console is allowed to write. Anything else is ignored. */
export const SETTING_KEYS = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REDIRECT_URI',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASSWORD',
  'SMTP_IMPLICIT_TLS',
  'SMTP_FROM_NAME',
  'SMTP_FROM_EMAIL',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_PHONE_NUMBER',
  'EXPO_ACCESS_TOKEN',
  'PUSH_ENABLED',
  'ANTHROPIC_API_KEY',
  'AI_MODEL',
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

const ALLOWED = new Set<string>(SETTING_KEYS);

export function isSecret(key: string): boolean {
  return SECRETS.has(key);
}

/** Reads every stored setting, decrypting secrets. */
export function storedSettings(): Record<string, string> {
  const rows = all<{ key: string; value: string }>(
    'SELECT key, value FROM app_setting WHERE key LIKE ?',
    `${PREFIX}%`,
  );

  const out: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.slice(PREFIX.length);
    if (!ALLOWED.has(key)) continue;

    if (SECRETS.has(key)) {
      const plain = open(row.value);
      // A null here means APP_SECRET changed since the value was written.
      // Treat it as absent rather than passing ciphertext to an API.
      if (plain === null) {
        logger.warn('Geymt leyndarmál er ólæsilegt — APP_SECRET hefur líklega breyst', { key });
        continue;
      }
      out[key] = plain;
    } else {
      out[key] = row.value;
    }
  }
  return out;
}

/**
 * Pushes stored settings into the config layer. Called once after the database
 * opens, and again after every save so changes take effect without a restart.
 */
export function applySettings(): void {
  setConfigOverrides(storedSettings());
}

/**
 * Writes settings. An empty string clears a value, falling back to the
 * environment or the built-in default.
 *
 * Secrets are a special case: a blank submission means "leave unchanged",
 * because the form never renders the current value, so blank is what an
 * untouched password field always sends.
 */
export function saveSettings(values: Record<string, string>): { saved: string[]; cleared: string[] } {
  const saved: string[] = [];
  const cleared: string[] = [];
  const now = Date.now();

  for (const [key, rawValue] of Object.entries(values)) {
    if (!ALLOWED.has(key)) continue;

    const value = rawValue.trim();
    const secret = SECRETS.has(key);

    if (value === '') {
      if (secret) continue; // untouched password field
      run('DELETE FROM app_setting WHERE key = ?', `${PREFIX}${key}`);
      cleared.push(key);
      continue;
    }

    // An explicit clear for a secret: the operator types this to remove it.
    if (secret && value === '-') {
      run('DELETE FROM app_setting WHERE key = ?', `${PREFIX}${key}`);
      cleared.push(key);
      continue;
    }

    run(
      `INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      `${PREFIX}${key}`,
      secret ? seal(value) : value,
      now,
    );
    saved.push(key);
  }

  applySettings();
  logger.info('Stillingar vistaðar', { saved, cleared });
  return { saved, cleared };
}

/**
 * Values for rendering the settings form. Secrets are replaced with a marker
 * so the browser never receives them, while still showing that one is set.
 */
export function settingsForForm(): Record<string, { value: string; hasSecret: boolean }> {
  const stored = storedSettings();
  const out: Record<string, { value: string; hasSecret: boolean }> = {};

  for (const key of SETTING_KEYS) {
    const value = stored[key] ?? '';
    out[key] = SECRETS.has(key)
      ? { value: '', hasSecret: value !== '' }
      : { value, hasSecret: false };
  }
  return out;
}

/** Which keys come from the environment rather than the console. */
export function environmentKeys(): string[] {
  const stored = storedSettings();
  return SETTING_KEYS.filter((key) => !stored[key] && Boolean(process.env[key]));
}

// ---------------------------------------------------------------------------
// Last SMTP test
// ---------------------------------------------------------------------------

export interface SmtpTestResult {
  at: number;
  status: string;
  recipient: string;
  error: string;
  host: string;
  warnings: string[];
}

const TEST_KEY = 'sidasta_postprofun';

/**
 * Stored rather than passed through the redirect: the raw SMTP error is long,
 * and a URL is the wrong place for a paragraph of diagnostics.
 */
export function recordSmtpTest(result: SmtpTestResult): void {
  run(
    `INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    TEST_KEY,
    JSON.stringify(result),
    Date.now(),
  );
}

export function lastSmtpTest(): SmtpTestResult | null {
  const row = all<{ value: string }>('SELECT value FROM app_setting WHERE key = ?', TEST_KEY)[0];
  if (!row) return null;
  try {
    return JSON.parse(row.value) as SmtpTestResult;
  } catch {
    return null;
  }
}
