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
    clientId: env('GOOGLE_CLIENT_ID'),
    clientSecret: env('GOOGLE_CLIENT_SECRET'),
    /** Must match the redirect URI registered in Google Cloud Console. */
    redirectUri: env('GOOGLE_REDIRECT_URI', `${env('BASE_URL', 'http://localhost:8080').replace(/\/+$/, '')}/oauth/google/callback`),
    get enabled(): boolean {
      return Boolean(config.google.clientId && config.google.clientSecret);
    },
  },

  smtp: {
    host: env('SMTP_HOST'),
    port: envInt('SMTP_PORT', 587),
    user: env('SMTP_USER'),
    password: env('SMTP_PASSWORD'),
    /** true = implicit TLS (port 465), false = STARTTLS upgrade (port 587). */
    implicitTls: envBool('SMTP_IMPLICIT_TLS', envInt('SMTP_PORT', 587) === 465),
    fromName: env('SMTP_FROM_NAME', 'Rafræn Þjónusta'),
    fromEmail: env('SMTP_FROM_EMAIL', env('SMTP_USER')),
    get enabled(): boolean {
      return Boolean(config.smtp.host && config.smtp.fromEmail);
    },
  },

  twilio: {
    accountSid: env('TWILIO_ACCOUNT_SID'),
    authToken: env('TWILIO_AUTH_TOKEN'),
    /** Number that answers calls, in E.164 (e.g. +3545550100). */
    phoneNumber: env('TWILIO_PHONE_NUMBER'),
    /** Verify inbound webhook signatures. Disable only for local testing. */
    validateSignature: envBool('TWILIO_VALIDATE_SIGNATURE', true),
    get enabled(): boolean {
      return Boolean(config.twilio.accountSid && config.twilio.authToken);
    },
  },

  push: {
    /** Expo push endpoint — works for both iOS and Android from one token. */
    expoEndpoint: env('EXPO_PUSH_ENDPOINT', 'https://exp.host/--/api/v2/push/send'),
    /** Optional; required only if the Expo project enforces push security. */
    expoAccessToken: env('EXPO_ACCESS_TOKEN'),
    enabled: envBool('PUSH_ENABLED', true),
  },

  ai: {
    /** Powers the phone receptionist's speech understanding and website copy. */
    apiKey: env('ANTHROPIC_API_KEY'),
    baseUrl: env('ANTHROPIC_BASE_URL', 'https://api.anthropic.com'),
    model: env('AI_MODEL', 'claude-sonnet-5'),
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
export function validateConfig(): string[] {
  const problems: string[] = [];

  if (!config.appSecret) {
    if (config.isProduction) {
      problems.push('APP_SECRET vantar — settu langan tilviljanakenndan streng (openssl rand -hex 32).');
    }
  } else if (config.appSecret.length < 32 && config.isProduction) {
    problems.push('APP_SECRET er of stutt — notaðu að minnsta kosti 32 stafi.');
  }

  if (config.isProduction && !config.baseUrl.startsWith('https://')) {
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
