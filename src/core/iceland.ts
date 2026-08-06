/**
 * Iceland-specific validation and formatting.
 *
 * Kennitala checksums, +354 phone normalisation, ISK/VSK money handling and
 * postcode lookups. These show up on every booking form, invoice and generated
 * website, so they live in one tested place.
 */

/** Icelandic VAT (virðisaukaskattur) rates. */
export const VSK = {
  /** Standard rate — most services, including hairdressing and vehicle repair. */
  standard: 0.24,
  /** Reduced rate — food, books, accommodation, some passenger transport. */
  reduced: 0.11,
  /** VAT-exempt (e.g. certain health services). */
  exempt: 0,
} as const;

export type VskRate = number;

// ---------------------------------------------------------------------------
// Kennitala
// ---------------------------------------------------------------------------

export type KennitalaType = 'einstaklingur' | 'fyrirtaeki';

export interface KennitalaInfo {
  valid: boolean;
  normalized: string;
  type: KennitalaType | null;
  /** Birth date for individuals; registration date for companies. */
  date: string | null;
  reason?: string;
}

/** Weights applied to the first eight digits of a kennitala. */
const KT_WEIGHTS = [3, 2, 7, 6, 5, 4, 3, 2];

export function normalizeKennitala(input: string): string {
  return input.replace(/[^0-9]/g, '');
}

/**
 * Validates the modulus-11 checksum and decodes the embedded date.
 *
 * Layout: DDMMYY-NNCX where C is the check digit and X the century marker
 * (8 → 1800s, 9 → 1900s, 0 → 2000s). Companies add 40 to the day of month,
 * so a kennitala beginning "45" is a business registered on the 5th.
 */
export function validateKennitala(input: string): KennitalaInfo {
  const digits = normalizeKennitala(input);
  const base: KennitalaInfo = { valid: false, normalized: digits, type: null, date: null };

  if (digits.length !== 10) {
    return { ...base, reason: 'Kennitala verður að vera 10 tölustafir.' };
  }

  const nums = [...digits].map(Number);
  const sum = KT_WEIGHTS.reduce((acc, weight, i) => acc + weight * nums[i]!, 0);
  const remainder = sum % 11;
  const expectedCheck = remainder === 0 ? 0 : 11 - remainder;

  // A remainder of 1 would require a check digit of 10, which cannot be
  // represented — such kennitölur are simply never issued.
  if (expectedCheck === 10 || expectedCheck !== nums[8]) {
    return { ...base, reason: 'Vartala kennitölu stemmir ekki.' };
  }

  const rawDay = Number(digits.slice(0, 2));
  const month = Number(digits.slice(2, 4));
  const yearSuffix = Number(digits.slice(4, 6));
  const centuryMarker = nums[9]!;

  const type: KennitalaType = rawDay > 40 ? 'fyrirtaeki' : 'einstaklingur';
  const day = type === 'fyrirtaeki' ? rawDay - 40 : rawDay;

  const century = centuryMarker === 8 ? 1800 : centuryMarker === 9 ? 1900 : centuryMarker === 0 ? 2000 : null;
  if (century === null) {
    return { ...base, reason: 'Ógild aldamótatala í kennitölu.' };
  }

  const year = century + yearSuffix;
  const asDate = new Date(Date.UTC(year, month - 1, day));
  const dateValid =
    month >= 1 && month <= 12 && day >= 1 &&
    asDate.getUTCFullYear() === year && asDate.getUTCMonth() === month - 1 && asDate.getUTCDate() === day;

  if (!dateValid) {
    return { ...base, reason: 'Dagsetning í kennitölu er ógild.' };
  }

  return {
    valid: true,
    normalized: digits,
    type,
    date: `${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`,
  };
}

/** "1234567890" → "123456-7890" */
export function formatKennitala(input: string): string {
  const digits = normalizeKennitala(input);
  return digits.length === 10 ? `${digits.slice(0, 6)}-${digits.slice(6)}` : input;
}

// ---------------------------------------------------------------------------
// Phone numbers
// ---------------------------------------------------------------------------

export interface PhoneInfo {
  valid: boolean;
  /** E.164, e.g. "+3545551234". Empty when invalid. */
  e164: string;
  /** Local display form, e.g. "555 1234". */
  display: string;
  kind: 'farsimi' | 'heimasimi' | 'graennumer' | 'thjonustunumer' | 'erlent' | null;
}

/**
 * Normalises Icelandic input to E.164. Accepts "5551234", "555-1234",
 * "+354 555 1234", "00354 5551234". Foreign numbers already in +xx form are
 * passed through so the platform can still call or text them.
 */
export function normalizePhone(input: string, defaultCountry = '354'): PhoneInfo {
  const invalid: PhoneInfo = { valid: false, e164: '', display: input.trim(), kind: null };
  let raw = input.trim().replace(/[\s\-().]/g, '');
  if (!raw) return invalid;

  if (raw.startsWith('00')) raw = `+${raw.slice(2)}`;

  if (raw.startsWith('+')) {
    const rest = raw.slice(1);
    if (!/^\d{7,15}$/.test(rest)) return invalid;
    if (rest.startsWith(defaultCountry)) {
      return describeIcelandic(rest.slice(defaultCountry.length));
    }
    return { valid: true, e164: `+${rest}`, display: `+${rest}`, kind: 'erlent' };
  }

  if (!/^\d+$/.test(raw)) return invalid;
  // Someone typed the country code without a plus.
  if (raw.length > 7 && raw.startsWith(defaultCountry)) {
    return describeIcelandic(raw.slice(defaultCountry.length));
  }
  return describeIcelandic(raw);
}

function describeIcelandic(local: string): PhoneInfo {
  if (!/^\d{7}$/.test(local)) {
    return { valid: false, e164: '', display: local, kind: null };
  }
  const first = local[0]!;
  // The 800/900 ranges must be tested before the mobile prefixes: freephone
  // numbers also start with 8, and classifying one as a mobile would make the
  // platform try to send it an SMS.
  const kind: PhoneInfo['kind'] =
    local.startsWith('800')
      ? 'graennumer'
      : local.startsWith('900')
        ? 'thjonustunumer'
        : first === '6' || first === '7' || first === '8'
          ? 'farsimi'
          : first === '4' || first === '5'
            ? 'heimasimi'
            : null;

  if (kind === null) return { valid: false, e164: '', display: local, kind: null };

  return {
    valid: true,
    e164: `+354${local}`,
    display: `${local.slice(0, 3)} ${local.slice(3)}`,
    kind,
  };
}

/** True for numbers that can receive SMS (mobiles only). */
export function canReceiveSms(phone: string): boolean {
  const info = normalizePhone(phone);
  return info.valid && (info.kind === 'farsimi' || info.kind === 'erlent');
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * ISK has no subunit in practice — amounts are whole krónur, grouped with a
 * full stop: "12.500 kr."
 */
export function formatISK(amount: number, options: { suffix?: boolean } = {}): string {
  const rounded = Math.round(amount);
  const sign = rounded < 0 ? '-' : '';
  const grouped = Math.abs(rounded).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${sign}${grouped}${options.suffix === false ? '' : ' kr.'}`;
}

/** Splits a VAT-inclusive price into net and VAT parts. */
export function splitVsk(grossAmount: number, rate: VskRate = VSK.standard): { net: number; vsk: number; gross: number } {
  const gross = Math.round(grossAmount);
  const net = Math.round(gross / (1 + rate));
  return { net, vsk: gross - net, gross };
}

/** Adds VAT to a net amount. */
export function addVsk(netAmount: number, rate: VskRate = VSK.standard): number {
  return Math.round(netAmount * (1 + rate));
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/** Icelandic postcodes → place name. Covers every populated postcode range. */
const POSTCODES: Record<string, string> = {
  101: 'Reykjavík', 102: 'Reykjavík', 103: 'Reykjavík', 104: 'Reykjavík', 105: 'Reykjavík',
  107: 'Reykjavík', 108: 'Reykjavík', 109: 'Reykjavík', 110: 'Reykjavík', 111: 'Reykjavík',
  112: 'Reykjavík', 113: 'Reykjavík', 116: 'Reykjavík', 121: 'Reykjavík', 123: 'Reykjavík',
  124: 'Reykjavík', 125: 'Reykjavík', 127: 'Reykjavík', 128: 'Reykjavík', 129: 'Reykjavík',
  130: 'Reykjavík', 132: 'Reykjavík', 150: 'Reykjavík', 155: 'Reykjavík',
  170: 'Seltjarnarnes', 172: 'Seltjarnarnes',
  190: 'Vogar', 200: 'Kópavogur', 201: 'Kópavogur', 202: 'Kópavogur', 203: 'Kópavogur', 206: 'Kópavogur',
  210: 'Garðabær', 212: 'Garðabær', 220: 'Hafnarfjörður', 221: 'Hafnarfjörður', 222: 'Hafnarfjörður',
  225: 'Álftanes', 230: 'Reykjanesbær', 232: 'Reykjanesbær', 233: 'Reykjanesbær', 235: 'Keflavíkurflugvöllur',
  240: 'Grindavík', 245: 'Suðurnesjabær', 250: 'Suðurnesjabær', 260: 'Reykjanesbær',
  270: 'Mosfellsbær', 271: 'Mosfellsbær', 276: 'Mosfellsbær',
  300: 'Akranes', 301: 'Akranes', 302: 'Akranes', 310: 'Borgarnes', 311: 'Borgarnes', 320: 'Reykholt í Borgarfirði',
  340: 'Stykkishólmur', 345: 'Flatey á Breiðafirði', 350: 'Grundarfjörður', 355: 'Ólafsvík',
  356: 'Snæfellsbær', 360: 'Hellissandur', 370: 'Búðardalur', 371: 'Búðardalur',
  380: 'Reykhólahreppur', 400: 'Ísafjörður', 401: 'Ísafjörður', 410: 'Hnífsdalur', 415: 'Bolungarvík',
  420: 'Súðavík', 425: 'Flateyri', 430: 'Suðureyri', 450: 'Patreksfjörður', 451: 'Patreksfjörður',
  460: 'Tálknafjörður', 465: 'Bíldudalur', 470: 'Þingeyri', 471: 'Þingeyri',
  500: 'Staður', 510: 'Hólmavík', 512: 'Hólmavík', 520: 'Drangsnes', 524: 'Árneshreppur',
  530: 'Hvammstangi', 531: 'Hvammstangi', 540: 'Blönduós', 541: 'Blönduós', 545: 'Skagaströnd',
  550: 'Sauðárkrókur', 551: 'Sauðárkrókur', 560: 'Varmahlíð', 565: 'Hofsós', 566: 'Hofsós', 570: 'Fljót',
  580: 'Siglufjörður', 600: 'Akureyri', 601: 'Akureyri', 602: 'Akureyri', 603: 'Akureyri', 604: 'Akureyri',
  605: 'Akureyri', 606: 'Akureyri', 607: 'Akureyri', 610: 'Grenivík', 611: 'Grímsey', 616: 'Grenivík',
  620: 'Dalvík', 621: 'Dalvík', 625: 'Ólafsfjörður', 630: 'Hrísey', 640: 'Húsavík', 641: 'Húsavík',
  645: 'Fosshóll', 650: 'Laugar', 660: 'Mývatn', 670: 'Kópasker', 671: 'Kópasker', 675: 'Raufarhöfn',
  680: 'Þórshöfn', 681: 'Þórshöfn', 685: 'Bakkafjörður', 690: 'Vopnafjörður', 691: 'Vopnafjörður',
  700: 'Egilsstaðir', 701: 'Egilsstaðir', 710: 'Seyðisfjörður', 715: 'Mjóifjörður', 720: 'Borgarfjörður eystri',
  730: 'Reyðarfjörður', 735: 'Eskifjörður', 740: 'Neskaupstaður', 750: 'Fáskrúðsfjörður',
  755: 'Stöðvarfjörður', 760: 'Breiðdalsvík', 765: 'Djúpivogur', 780: 'Höfn í Hornafirði', 781: 'Höfn í Hornafirði',
  785: 'Öræfi', 800: 'Selfoss', 801: 'Selfoss', 802: 'Selfoss', 803: 'Selfoss', 804: 'Selfoss',
  805: 'Selfoss', 806: 'Selfoss', 810: 'Hveragerði', 815: 'Þorlákshöfn', 816: 'Ölfus', 820: 'Eyrarbakki',
  825: 'Stokkseyri', 840: 'Laugarvatn', 845: 'Flúðir', 846: 'Flúðir', 850: 'Hella', 851: 'Hella',
  860: 'Hvolsvöllur', 861: 'Hvolsvöllur', 870: 'Vík', 871: 'Vík', 880: 'Kirkjubæjarklaustur',
  881: 'Kirkjubæjarklaustur', 900: 'Vestmannaeyjar', 902: 'Vestmannaeyjar',
};

export function placeForPostcode(postcode: string): string | null {
  return POSTCODES[normalizeKennitala(postcode).slice(0, 3)] ?? null;
}

export function isValidPostcode(postcode: string): boolean {
  return placeForPostcode(postcode) !== null;
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/** Basic, deliberately permissive email check — real validation is delivery. */
export function isValidEmail(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 6 || trimmed.length > 254) return false;
  return /^[^\s@,;:<>"()[\]\\]+@[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/.test(trimmed);
}

/** "a, b og c" — Icelandic list conjunction. */
export function joinIs(items: readonly string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0]!;
  return `${items.slice(0, -1).join(', ')} og ${items[items.length - 1]}`;
}

/**
 * Icelandic gendered number agreement for the common booking counts.
 * "1 bókun" / "2 bókanir".
 */
export function pluralIs(count: number, singular: string, plural: string): string {
  // Numbers ending in 1 (but not 11) take the singular: 21 bókun, but 11 bókanir.
  const lastTwo = Math.abs(count) % 100;
  const last = Math.abs(count) % 10;
  const useSingular = last === 1 && lastTwo !== 11;
  return `${count} ${useSingular ? singular : plural}`;
}
