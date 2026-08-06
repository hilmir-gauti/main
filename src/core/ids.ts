/**
 * Identifier generation.
 *
 * Two flavours:
 *  - `id(prefix)`  — sortable, prefixed, URL-safe primary keys (ULID-like).
 *  - `token(n)`    — opaque high-entropy secrets (session ids, cancel links).
 *
 * Prefixed ids make logs and database dumps readable at a glance: you can tell
 * `bok_01J…` (booking) from `vsk_01J…` (tenant) without a lookup.
 */

import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/** Crockford base32 — no I, L, O or U, so ids survive being read over the phone. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeTime(ms: number, length: number): string {
  let out = '';
  let value = ms;
  for (let i = 0; i < length; i++) {
    out = ALPHABET[value % 32] + out;
    value = Math.floor(value / 32);
  }
  return out;
}

function encodeRandom(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i]! % 32];
  return out;
}

export const ID_PREFIX = {
  tenant: 'vsk', // viðskiptavinur — the small business we serve
  service: 'thj', // þjónusta
  staff: 'stf',
  booking: 'bok',
  customer: 'kun', // kúnni — the end customer who books
  device: 'tki', // tæki
  call: 'sim', // símtal
  message: 'msg',
  task: 'verk',
  oauth: 'oau',
  session: 'ses',
  busy: 'upp', // upptekið
  build: 'vef',
  note: 'nta',
} as const;

export type IdPrefix = (typeof ID_PREFIX)[keyof typeof ID_PREFIX];

/**
 * Monotonic within a millisecond is not guaranteed, but 16 random base32 chars
 * (80 bits) make a collision inside one millisecond effectively impossible.
 */
export function id(prefix: IdPrefix | string): string {
  return `${prefix}_${encodeTime(Date.now(), 10)}${encodeRandom(16)}`;
}

/** Opaque secret, URL-safe. 32 bytes ≈ 43 chars by default. */
export function token(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Short human-friendly code for pairing a phone to a tenant.
 * Uses the same ambiguity-free alphabet so it can be dictated aloud.
 */
export function pairingCode(length = 6): string {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(0, 32)];
  return out.replace(/(.{3})(?=.)/g, '$1-');
}

/** Constant-time comparison for secrets. Length differences are not leaked. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Still burn a comparison so timing does not reveal the length mismatch.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * URL slug from a company name. Icelandic characters are transliterated so the
 * result works in domains and file paths: "Hárgreiðslustofan Ösp" → "hargreidslustofan-osp".
 */
export function slugify(input: string): string {
  const map: Record<string, string> = {
    á: 'a', Á: 'a', é: 'e', É: 'e', í: 'i', Í: 'i', ó: 'o', Ó: 'o',
    ú: 'u', Ú: 'u', ý: 'y', Ý: 'y', þ: 'th', Þ: 'th', æ: 'ae', Æ: 'ae',
    ð: 'd', Ð: 'd', ö: 'o', Ö: 'o', ä: 'a', Ä: 'a', ü: 'u', Ü: 'u', å: 'a', Å: 'a',
    ø: 'o', Ø: 'o', ñ: 'n', Ñ: 'n', ç: 'c', Ç: 'c',
  };
  const transliterated = input.replace(/[^\u0000-\u007F]/g, (ch) => map[ch] ?? '');
  return transliterated
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'fyrirtaeki';
}
