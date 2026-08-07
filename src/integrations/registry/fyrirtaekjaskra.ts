/**
 * Fyrirtækjaskrá lookup — company facts by kennitala.
 *
 * Skatturinn publishes the company register as HTML at a stable per-kennitala
 * URL. There is no JSON API, so the page is parsed. That is brittle by nature,
 * which is why every field is optional and a parse that finds nothing returns
 * "not found" rather than a half-built record: a wizard prefilled with wrong
 * facts is worse than one the operator fills in themselves.
 *
 * This is the authoritative source for the company's *identity* — legal name,
 * address, legal form, ÍSAT classification, VSK number. It deliberately does
 * not carry a phone number, an email or a website, and nothing here invents
 * them.
 *
 * One request per onboarding, cached. This is an operator looking up a client
 * they are about to sign, not a crawler.
 */

import { logger } from '../../core/logger.ts';
import { validateKennitala } from '../../core/iceland.ts';

const BASE = 'https://www.skatturinn.is/fyrirtaekjaskra/leit/kennitala';

export interface RegistryCompany {
  kennitala: string;
  /** Registered legal name, e.g. "Hárgreiðslustofan Ösp ehf." */
  name: string;
  address: string;
  postcode: string;
  city: string;
  /** Legal form as written, e.g. "Einkahlutafélag (ehf)". */
  legalForm: string;
  /** ÍSAT classification code, e.g. "96.02.1". */
  isatCode: string;
  isatLabel: string;
  /** VSK registration number, when the company is VSK-registered. */
  vskNumber: string;
  /** Registration date as written on the page, e.g. "07.10.2008". */
  registered: string;
}

/** Strips tags and collapses whitespace, leaving the page's visible text lines. */
function textLines(source: string): string[] {
  const withoutNoise = source.replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  return withoutNoise
    .replace(/<[^>]+>/g, '\n')
    .split('\n')
    .map((line) => decodeEntities(line).replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0);
}

function decodeEntities(text: string): string {
  return text
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, name: string) => {
      switch (name) {
        case 'amp': return '&';
        case 'lt': return '<';
        case 'gt': return '>';
        case 'quot': return '"';
        case '#39': return "'";
        default: return ' ';
      }
    })
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
}

/** Value of the line following a label, when it is present. */
function after(lines: string[], label: string, within = 4): string {
  const index = lines.findIndex((line) => line === label);
  if (index === -1) return '';
  for (let offset = 1; offset <= within; offset++) {
    const candidate = lines[index + offset];
    if (candidate && candidate !== label) return candidate;
  }
  return '';
}

/** One cell's visible text, with any internal markup flattened to spaces. */
function cellText(cell: string): string {
  return decodeEntities(cell.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * The address block is a table: one header row, then one row of values. Read
 * as a flat run of lines it looks like four labels followed by eight values,
 * so the columns have to be paired up structurally rather than positionally.
 */
function tableFields(html: string): Record<string, string> {
  const out: Record<string, string> = {};

  for (const table of html.match(/<table[\s\S]*?<\/table>/gi) ?? []) {
    const rows = table.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
    if (rows.length < 2) continue;

    const headers = (rows[0]?.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) ?? []).map(cellText);
    const values = (rows[1]?.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) ?? []).map(cellText);
    if (!headers.includes('Póstfang')) continue;

    headers.forEach((header, index) => {
      const value = values[index];
      if (header && value) out[header] = value;
    });
    break;
  }

  return out;
}

/**
 * Parses the register page.
 *
 * Exported so the parser can be tested against saved pages without a network
 * call — the shape of this HTML is the part most likely to change under us.
 */
export function parseRegistryPage(html: string, kennitala: string): RegistryCompany | null {
  const lines = textLines(html);

  // The heading carries both name and kennitala: "Landsbankinn hf. (4710080280)".
  const digits = kennitala.replace(/\D/g, '');
  const heading = lines.find((line) => line.includes(`(${digits})`));
  if (!heading) return null;

  const name = heading.slice(0, heading.indexOf(`(${digits})`)).trim();
  if (!name) return null;

  const fields = tableFields(html);

  // "Reykjastræti 6 101 Reykjavík" — street, postcode and place run together,
  // and only the postcode is reliably shaped, so split on it.
  const postal = fields['Póstfang'] ?? fields['Lögheimili'] ?? '';
  const postMatch = /^(.*?)\s*(\d{3})\s+(.+)$/.exec(postal);
  const address = postMatch?.[1]?.trim() ?? postal;

  // "D1 Hlutafélag, almennt (hf)" — the leading form code is internal to RSK.
  const legalForm = (fields['Rekstrarform'] ?? '').replace(/^[A-Z]\d+\s+/, '').trim();

  // "96.02.1 Hárgreiðslustofur" — code and label on one line.
  const isatLine = after(lines, 'ÍSAT Atvinnugreinaflokkun');
  const isatMatch = /^(\d{2}\.\d{2}\.\d)\s+(.+)$/.exec(isatLine);

  const registered = (() => {
    const line = lines.find((entry) => entry.startsWith('Stofnað/Skráð'));
    return line ? line.replace(/^Stofnað\/Skráð:?\s*/, '').trim() : '';
  })();

  // The VSK block lists "Númer" as a header followed by the number itself.
  const vskNumber = (() => {
    const index = lines.indexOf('Virðisaukaskattsnúmer');
    if (index === -1) return '';
    for (let offset = 1; offset <= 8; offset++) {
      const candidate = lines[index + offset] ?? '';
      if (/^\d{4,6}$/.test(candidate)) return candidate;
    }
    return '';
  })();

  return {
    kennitala: digits,
    name,
    address,
    postcode: postMatch?.[2] ?? '',
    city: postMatch?.[3] ?? '',
    legalForm,
    isatCode: isatMatch?.[1] ?? '',
    isatLabel: isatMatch?.[2] ?? '',
    vskNumber,
    registered,
  };
}

/** Cached per process. Onboarding retries should not re-fetch. */
const cache = new Map<string, RegistryCompany | null>();

export async function lookupCompany(kennitala: string): Promise<RegistryCompany | null> {
  const digits = kennitala.replace(/\D/g, '');

  const check = validateKennitala(digits);
  if (!check.valid) return null;
  // A personal kennitala has no company record, and asking for one would send
  // an individual's identifier to a third party for nothing.
  if (check.type !== 'fyrirtaeki') return null;

  if (cache.has(digits)) return cache.get(digits) ?? null;

  try {
    const response = await fetch(`${BASE}/${digits}`, {
      headers: {
        'user-agent': 'RafraenThjonusta/1.0 (+uppfletting vidskiptavinar)',
        accept: 'text/html',
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      logger.warn('Fyrirtækjaskrá svaraði ekki', { kennitala: digits, status: response.status });
      return null;
    }

    const parsed = parseRegistryPage(await response.text(), digits);
    cache.set(digits, parsed);
    return parsed;
  } catch (error) {
    // A failed lookup is never fatal — the operator types the fields instead.
    logger.warn('Uppfletting í fyrirtækjaskrá mistókst', { kennitala: digits, error: String(error) });
    return null;
  }
}

export function clearRegistryCache(): void {
  cache.clear();
}
