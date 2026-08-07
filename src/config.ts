/**
 * Stillingar (configuration).
 *
 * Everything is read from the environment once, at startup, and validated here
 * so that a misconfigured deployment fails loudly instead of halfway through a
 * customer's booking.
 *
 * Integrations degrade gracefully: when credentials are missing the matching
 * adapter runs in "þurrkeyrsla" (dry-run) mode — it records exactly what it
 * would have done instead of throwing. That keeps the whole platform runnable
 * from day one, before any external accounts exist.
 */

import { resolve } from 'node:path';

export type NodeEnv = 'development' | 'production' | 'test';

function env(key: string, fallback = ''): string {
  const raw = process.env[key];
  return raw === undefined || raw === '' ? fallback : raw;
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key]?.toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'já';
}

const nodeEnv = (env('NODE_ENV', 'development') as NodeEnv) || 'development';
const dataDir = resolve(env('DATA_DIR', './data'));

/**
 * Integration credentials entered in the control panel.
 *
 * The packaged desktop build has no `.env` and no shell, so credentials are
 * stored (encrypted) in the database and pushed in here once it opens. They
 * take precedence over environment variables: someone who typed a value into
 * the UI expects that value to win over whatever the machine was started with.
 *
 * Kept as a plain mutable object rather than importing the settings module,
 * because `core/db.ts` imports this file — the dependency has to point one way.
 */
let overrides: Record<string, string> = {};

export function setConfigOverrides(next: Record<string, string>): void {
  overrides = { ...next };
}

export function configOverrides(): Record<string, string> {
  return { ...overrides };
}

/** Override first, then environment, then the default. */
function setting(key: string, fallback = ''): string {
  const override = overrides[key];
  if (override !== undefined && override !== '') return override;
  return env(key, fallback);
}

function settingInt(key: string, fallback: number): number {
  const raw = setting(key);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function settingBool(key: string, fallback: boolean): boolean {
  const raw = setting(key).toLowerCase();
  if (raw === '') return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'já';
}

export const config = {
  env: nodeEnv,
  isProduction: nodeEnv === 'production',
  isTest: nodeEnv === 'test',

  /** Public base URL of this control plane. Used for OAuth + webhook callbacks. */
  baseUrl: env('BASE_URL', `http://localhost:${envInt('PORT', 8080)}`).replace(/\/+$/, ''),
  port: envInt('PORT', 8080),
  host: env('HOST', '0.0.0.0'),

  dataDir,
  databasePath: resolve(env('DATABASE_PATH', `${dataDir}/rafraen.sqlite`)),
  /** Where generated tenant websites are written. */
  sitesDir: resolve(env('SITES_DIR', `${dataDir}/sites`)),

  /**
   * Master secret. Derives the session signing key and the AES-GCM key that
   * encrypts third-party tokens at rest. Rotating it invalidates sessions and
   * makes stored OAuth tokens unreadable (they can be re-linked).
   */
  appSecret: env('APP_SECRET'),

  /** Single-operator login. This platform has exactly one human user: you. */
  operator: {
    email: env('OPERATOR_EMAIL'),
    /** Only read by `npm run setup`, never stored in plaintext. */
    initialPassword: env('OPERATOR_PASSWORD'),
    sessionTtlHours: envInt('SESSION_TTL_HOURS', 12),
  },

  defaults: {
    timezone: env('DEFAULT_TIMEZONE', 'Atlantic/Reykjavik'),
    locale: env('DEFAULT_LOCALE', 'is-IS'),
    currency: 'ISK',
    countryCode: '354',
  },

  google: {
    get clientId(): string {
      return setting('GOOGLE_CLIENT_ID');
    },
    get clientSecret(): string {
      return setting('GOOGLE_CLIENT_SECRET');
    },
    /** Must match the redirect URI registered in Google Cloud Console. */
    get redirectUri(): string {
      return setting('GOOGLE_REDIRECT_URI', `${config.baseUrl}/oauth/google/callback`);
    },
    get enabled(): boolean {
      return Boolean(config.google.clientId && config.google.clientSecret);
    },
  },

  smtp: {
    get host(): string {
      return setting('SMTP_HOST');
    },
    get port(): number {
      return settingInt('SMTP_PORT', 587);
    },
    get user(): string {
      return setting('SMTP_USER');
    },
    get password(): string {
      return setting('SMTP_PASSWORD');
    },
    /** true = implicit TLS (port 465), false = STARTTLS upgrade (port 587). */
    get implicitTls(): boolean {
      return settingBool('SMTP_IMPLICIT_TLS', config.smtp.port === 465);
    },
    get fromName(): string {
      return setting('SMTP_FROM_NAME', 'Rafræn Þjónusta');
    },
    get fromEmail(): string {
      return setting('SMTP_FROM_EMAIL', config.smtp.user);
    },
    get enabled(): boolean {
      return Boolean(config.smtp.host && config.smtp.fromEmail);
    },
  },

  twilio: {
    get accountSid(): string {
      return setting('TWILIO_ACCOUNT_SID');
    },
    get authToken(): string {
      return setting('TWILIO_AUTH_TOKEN');
    },
    /** Number that answers calls, in E.164 (e.g. +3545550100). */
    get phoneNumber(): string {
      return setting('TWILIO_PHONE_NUMBER');
    },
    /** Verify inbound webhook signatures. Disable only for local testing. */
    get validateSignature(): boolean {
      return settingBool('TWILIO_VALIDATE_SIGNATURE', true);
    },
    get enabled(): boolean {
      return Boolean(config.twilio.accountSid && config.twilio.authToken);
    },
  },

  vercel: {
    /** Personal or team token from vercel.com/account/tokens. */
    get token(): string {
      return setting('VERCEL_TOKEN');
    },
    /** Only needed when the projects belong to a team rather than a personal account. */
    get teamId(): string {
      return setting('VERCEL_TEAM_ID');
    },
    /**
     * Prefix for the generated project names, so a Vercel account shared with
     * other work stays legible: `rth-harstofan-osp` rather than `harstofan-osp`.
     */
    get projectPrefix(): string {
      return setting('VERCEL_PROJECT_PREFIX', 'rth');
    },
    get enabled(): boolean {
      return Boolean(config.vercel.token);
    },
  },

  push: {
    /** Expo push endpoint — works for both iOS and Android from one token. */
    get expoEndpoint(): string {
      return setting('EXPO_PUSH_ENDPOINT', 'https://exp.host/--/api/v2/push/send');
    },
    /** Optional; required only if the Expo project enforces push security. */
    get expoAccessToken(): string {
      return setting('EXPO_ACCESS_TOKEN');
    },
    get enabled(): boolean {
      return settingBool('PUSH_ENABLED', true);
    },
  },

  ai: {
    /** Powers the phone receptionist's speech understanding and website copy. */
    get apiKey(): string {
      return setting('ANTHROPIC_API_KEY');
    },
    get baseUrl(): string {
      return setting('ANTHROPIC_BASE_URL', 'https://api.anthropic.com');
    },
    get model(): string {
      return setting('AI_MODEL', 'claude-sonnet-5');
    },
    get enabled(): boolean {
      return Boolean(config.ai.apiKey);
    },
  },

  booking: {
    /** Granularity of offered slots, in minutes. */
    slotGranularityMin: envInt('SLOT_GRANULARITY_MIN', 15),
    /** How far ahead the public booking page will look. */
    maxAdvanceDays: envInt('MAX_ADVANCE_DAYS', 90),
    /** Reminder lead time before an appointment. */
    reminderHoursBefore: envInt('REMINDER_HOURS_BEFORE', 24),
    /** How often background jobs (reminders, calendar sync) run. */
    workerIntervalSec: envInt('WORKER_INTERVAL_SEC', 60),
  },

  logLevel: env('LOG_LEVEL', nodeEnv === 'test' ? 'error' : 'info'),
} as const;

export type Config = typeof config;

/**
 * Fails fast on configuration that is unsafe in production. Development keeps
 * working with generated stand-ins so `npm start` never blocks on setup.
 */
/**
 * Whether a value looks like a shell command the shell never ran.
 *
 * `fly secrets set APP_SECRET="$(openssl rand -hex 32)"` is correct in bash and
 * silently wrong in CMD and PowerShell, which pass the text through verbatim.
 * Nothing downstream notices — the value is simply a short, fixed string — so
 * the check happens here, where the length is already being questioned.
 *
 * Random secrets are hex or base64 and carry none of this punctuation, so the
 * test cannot fire on a real value.
 */
export function looksUnexpanded(value: string): boolean {
  return /^[$%`]|\$\(|\$\{|%[A-Za-z_]+%/.test(value);
}

export function validateConfig(): string[] {
  const problems: string[] = [];

  if (!config.appSecret) {
    if (config.isProduction) {
      problems.push('APP_SECRET vantar — settu langan tilviljanakenndan streng (openssl rand -hex 32).');
    }
  } else if (config.appSecret.length < 32 && config.isProduction) {
    // The length is safe to log and is the whole diagnosis: a value that is
    // present but short almost always means the shell did not expand what was
    // typed, which is silent everywhere except here.
    problems.push(
      `APP_SECRET er of stutt (${config.appSecret.length} stafir) — notaðu að minnsta kosti 32.`,
    );

    if (looksUnexpanded(config.appSecret)) {
      problems.push(
        'APP_SECRET lítur út eins og óútvíkkuð skipun úr skel. `$(...)` virkar í bash en ekki í ' +
        'Windows-skel — búðu til gildið fyrst og límdu það svo inn: ' +
        'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
      );
    }
  }

  // Loopback is exempt: the packaged desktop build serves the console to the
  // machine it runs on, where plain HTTP never crosses a network boundary and
  // browsers reject Secure cookies anyway.
  if (config.isProduction && !config.baseUrl.startsWith('https://') && !isLoopback(config.baseUrl)) {
    problems.push('BASE_URL verður að nota https:// í rekstri (session-kökur eru merktar Secure).');
  }

  if (config.google.enabled && !config.google.redirectUri.startsWith(config.baseUrl)) {
    problems.push(`GOOGLE_REDIRECT_URI (${config.google.redirectUri}) passar ekki við BASE_URL (${config.baseUrl}).`);
  }

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: config.defaults.timezone });
  } catch {
    problems.push(`DEFAULT_TIMEZONE "${config.defaults.timezone}" er ekki gilt IANA tímabelti.`);
  }

  if (config.booking.slotGranularityMin < 5 || config.booking.slotGranularityMin > 120) {
    problems.push('SLOT_GRANULARITY_MIN verður að vera á bilinu 5–120 mínútur.');
  }

  return problems;
}

/** True when a URL points at this machine, e.g. the desktop build. */
export function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

/**
 * Whether session cookies should carry the `Secure` flag. Setting it on a
 * plain-HTTP loopback origin makes the browser drop the cookie entirely, which
 * would silently break login in the desktop build.
 */
export function useSecureCookies(): boolean {
  return config.baseUrl.startsWith('https://');
}

/** Human-readable integration status, shown on the admin dashboard. */
export function integrationStatus(): Array<{ key: string; label: string; ready: boolean; hint: string }> {
  return [
    {
      key: 'google',
      label: 'Google Calendar',
      ready: config.google.enabled,
      hint: config.google.enabled ? 'Tengt' : 'Vantar GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET',
    },
    {
      key: 'email',
      label: 'Tölvupóstur (SMTP)',
      ready: config.smtp.enabled,
      hint: config.smtp.enabled ? `Sendir gegnum ${config.smtp.host}` : 'Vantar SMTP_HOST / SMTP_FROM_EMAIL — póstur fer í þurrkeyrslu',
    },
    {
      key: 'phone',
      label: 'Símsvörun (Twilio)',
      ready: config.twilio.enabled,
      hint: config.twilio.enabled ? `Númer ${config.twilio.phoneNumber || 'óstillt'}` : 'Vantar TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN',
    },
    {
      key: 'vercel',
      label: 'Vefhýsing (Vercel)',
      ready: config.vercel.enabled,
      hint: config.vercel.enabled
        ? 'Vefsíður fara í loftið á Vercel'
        : 'Vantar VERCEL_TOKEN — vefsíður eru smíðaðar en hýstar hér heima',
    },
    {
      key: 'push',
      label: 'Snjallsímatilkynningar',
      ready: config.push.enabled,
      hint: config.push.enabled ? 'Expo push virkt (iOS + Android)' : 'Slökkt með PUSH_ENABLED=false',
    },
    {
      key: 'ai',
      label: 'Gervigreind (símsvari og textagerð)',
      ready: config.ai.enabled,
      hint: config.ai.enabled ? `Líkan ${config.ai.model}` : 'Vantar ANTHROPIC_API_KEY — símsvari notar takkavalmynd í staðinn',
    },
  ];
}
