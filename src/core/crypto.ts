/**
 * Cryptography helpers: password hashing, at-rest encryption and HMAC signing.
 *
 * Third-party credentials (Google refresh tokens, per-tenant SMTP passwords)
 * are encrypted with a key derived from APP_SECRET before they touch the
 * database, so a stolen database file alone does not hand over a customer's
 * calendar or mailbox.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

import { config } from '../config.ts';
import { AppError } from './errors.ts';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>;

/**
 * In development we tolerate a missing APP_SECRET by generating an ephemeral
 * one — restarting invalidates sessions and stored tokens, which is a loud
 * enough signal without blocking local work. `validateConfig()` rejects this
 * in production.
 */
const rootSecret: Buffer = (() => {
  if (config.appSecret) return Buffer.from(config.appSecret, 'utf8');
  if (config.isProduction) {
    throw new AppError(500, 'stillingavilla', 'APP_SECRET vantar.', {
      internalMessage: 'APP_SECRET is required in production.',
    });
  }
  return randomBytes(32);
})();

/** Domain-separated subkeys, so a leak in one context cannot forge another. */
function subkey(purpose: string, length = 32): Buffer {
  return Buffer.from(hkdfSync('sha256', rootSecret, Buffer.alloc(0), Buffer.from(purpose, 'utf8'), length));
}

const ENCRYPTION_KEY = subkey('rafraen:encryption:v1');
const SIGNING_KEY = subkey('rafraen:signing:v1');

// ---------------------------------------------------------------------------
// Password hashing (operator login)
// ---------------------------------------------------------------------------

const SCRYPT_KEYLEN = 64;

/** Returns `scrypt$<saltHex>$<hashHex>`, safe to store verbatim. */
export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12) {
    throw new AppError(422, 'veikt_lykilord', 'Lykilorð verður að vera að minnsta kosti 12 stafir.');
  }
  const salt = randomBytes(16);
  const derived = await scrypt(password.normalize('NFKC'), salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

/** Constant-time verification. Never throws on malformed input — returns false. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1]!, 'hex');
  const expected = Buffer.from(parts[2]!, 'hex');
  if (salt.length === 0 || expected.length !== SCRYPT_KEYLEN) return false;
  const derived = await scrypt(password.normalize('NFKC'), salt, SCRYPT_KEYLEN);
  return timingSafeEqual(derived, expected);
}

// ---------------------------------------------------------------------------
// Symmetric encryption for stored third-party secrets
// ---------------------------------------------------------------------------

/**
 * AES-256-GCM. Output format: `v1.<iv>.<tag>.<ciphertext>` (all base64url).
 * The version prefix leaves room to rotate algorithms later without a
 * migration that has to guess at the old format.
 */
export function seal(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

/** Returns null when the value cannot be decrypted (e.g. APP_SECRET rotated). */
export function open(sealed: string | null | undefined): string | null {
  if (!sealed) return null;
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  try {
    const iv = Buffer.from(parts[1]!, 'base64url');
    const tag = Buffer.from(parts[2]!, 'base64url');
    const data = Buffer.from(parts[3]!, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// HMAC signing (cancellation links, pairing payloads, CSRF)
// ---------------------------------------------------------------------------

export function sign(value: string): string {
  return createHmac('sha256', SIGNING_KEY).update(value).digest('base64url');
}

/** `<value>.<signature>` — tamper-evident but not secret. */
export function signValue(value: string): string {
  return `${Buffer.from(value, 'utf8').toString('base64url')}.${sign(value)}`;
}

export function unsignValue(signed: string): string | null {
  const dot = signed.lastIndexOf('.');
  if (dot <= 0) return null;
  const encoded = signed.slice(0, dot);
  const signature = signed.slice(dot + 1);
  let value: string;
  try {
    value = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const expected = Buffer.from(sign(value), 'utf8');
  const actual = Buffer.from(signature, 'utf8');
  if (expected.length !== actual.length) return null;
  return timingSafeEqual(expected, actual) ? value : null;
}

/** SHA-256 via HMAC with the signing key — used to store session ids at rest. */
export function hashToken(raw: string): string {
  return createHmac('sha256', SIGNING_KEY).update(raw).digest('hex');
}
