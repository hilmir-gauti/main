/**
 * Structured logging with secret redaction.
 *
 * Every log line is JSON in production (easy to ship to a log service) and
 * colourised single-line text in development.
 */

import { config } from '../config.ts';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 } as const;
export type LogLevel = keyof typeof LEVELS;

const threshold = LEVELS[(config.logLevel as LogLevel) in LEVELS ? (config.logLevel as LogLevel) : 'info'];

/** Keys whose values must never reach a log file. */
const SECRET_KEYS = /^(password|passwd|secret|token|access_token|refresh_token|auth_token|api_key|apikey|authorization|cookie|set-cookie|client_secret|totp|kennitala)$/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[djúpt]';
  if (value === null || value === undefined) return value;
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.test(k) ? '[hulið]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

const COLOURS: Record<string, string> = {
  debug: '\u001b[90m',
  info: '\u001b[36m',
  warn: '\u001b[33m',
  error: '\u001b[31m',
};
const RESET = '\u001b[0m';

function emit(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const time = new Date().toISOString();
  const safeMeta = meta ? (redact(meta) as Record<string, unknown>) : undefined;

  if (config.isProduction) {
    process.stdout.write(`${JSON.stringify({ time, level, msg, ...safeMeta })}\n`);
    return;
  }

  const colour = COLOURS[level] ?? '';
  const tail = safeMeta && Object.keys(safeMeta).length > 0 ? ` ${JSON.stringify(safeMeta)}` : '';
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(`${colour}${time.slice(11, 19)} ${level.toUpperCase().padEnd(5)}${RESET} ${msg}${tail}\n`);
}

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

function build(bindings: Record<string, unknown>): Logger {
  const merge = (meta?: Record<string, unknown>) =>
    Object.keys(bindings).length ? { ...bindings, ...meta } : meta;
  return {
    debug: (msg, meta) => emit('debug', msg, merge(meta)),
    info: (msg, meta) => emit('info', msg, merge(meta)),
    warn: (msg, meta) => emit('warn', msg, merge(meta)),
    error: (msg, meta) => emit('error', msg, merge(meta)),
    child: (extra) => build({ ...bindings, ...extra }),
  };
}

export const logger: Logger = build({});
