/**
 * Reading a company's existing website.
 *
 * When a business already has a site, everything worth knowing about how it
 * presents itself is on it: how it describes what it does, its colour, its
 * phone number, its price list. Retyping that is the slowest part of
 * onboarding, and the operator retyping it is also the step where it gets
 * wrong.
 *
 * So the old site is read and its content lifted across. What is *not* lifted
 * is the design — the point of the exercise is a better-looking page, not a
 * copy of the one they have.
 *
 * Everything is best-effort. A field that cannot be found with confidence is
 * left out rather than guessed at, and the caller decides what to keep: the
 * import surfaces as a proposal in the console, never as a silent overwrite.
 */

import { logger } from '../core/logger.ts';
import { isValidEmail, normalizePhone } from '../core/iceland.ts';
import { isBrandColor } from './palette-defaults.ts';

export interface ImportedSite {
  url: string;
  title: string;
  /** Meta description or the first substantial paragraph. */
  tagline: string;
  /** The longest run of prose found, used as "about". */
  about: string;
  brandColor: string;
  phone: string;
  email: string;
  /** Price-list-looking lines: a name and an ISK amount. */
  services: Array<{ name: string; priceIsk: number }>;
  socials: string[];
  /** Anything notable that was found but not used, shown to the operator. */
  notes: string[];
}

const MAX_BYTES = 1_500_000;

function decodeEntities(text: string): string {
  return text
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, name: string) => {
      switch (name) {
        case 'amp': return '&';
        case 'lt': return '<';
        case 'gt': return '>';
        case 'quot': return '"';
        case '#39': case 'apos': return "'";
        default: return ' ';
      }
    })
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

/** Body text with markup, scripts, styles and navigation chrome removed. */
function visibleText(html: string): string[] {
  return html
    .replace(/<(script|style|noscript|svg|head|nav|footer)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, '\n')
    .split('\n')
    .map((line) => decodeEntities(line).replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0);
}

function metaContent(html: string, pattern: RegExp): string {
  const tag = html.match(pattern)?.[0] ?? '';
  const content = /content\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? '';
  return decodeEntities(content).trim();
}

/**
 * The site's own colour.
 *
 * `theme-color` is the honest answer when present — it is declared, not
 * inferred. Otherwise the most frequently used non-neutral colour in the
 * stylesheet is a good proxy for a brand colour, because neutrals dominate
 * body text and borders while the brand shows up in buttons and links.
 */
export function extractBrandColor(html: string): string {
  const declared = metaContent(html, /<meta[^>]+name\s*=\s*["']theme-color["'][^>]*>/i);
  if (isBrandColor(declared)) return declared.toLowerCase();

  const counts = new Map<string, number>();
  for (const match of html.matchAll(/#([0-9a-fA-F]{6})\b/g)) {
    const hex = `#${match[1]!.toLowerCase()}`;
    const r = Number.parseInt(hex.slice(1, 3), 16);
    const g = Number.parseInt(hex.slice(3, 5), 16);
    const b = Number.parseInt(hex.slice(5, 7), 16);

    // Skip neutrals and near-blacks/whites: those are text and chrome, and a
    // site whose "brand colour" came out #333333 looks broken.
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max - min < 40) continue;
    if (max < 40 || min > 225) continue;

    counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }

  let best = '';
  let bestCount = 0;
  for (const [hex, count] of counts) {
    if (count > bestCount) { best = hex; bestCount = count; }
  }
  // One stray coloured pixel is not a brand.
  return bestCount >= 2 ? best : '';
}

/** Icelandic price lines: a label followed by an ISK amount. */
export function extractServices(lines: string[]): Array<{ name: string; priceIsk: number }> {
  const out: Array<{ name: string; priceIsk: number }> = [];
  const seen = new Set<string>();

  const price = (text: string): number => {
    const match = /(\d{1,3}(?:[.\s]\d{3})+|\d{4,6})\s*(?:kr\.?|ISK|krónur)/i.exec(text);
    if (!match) return 0;
    const amount = Number.parseInt(match[1]!.replace(/[.\s]/g, ''), 10);
    // Below a thousand is almost always a year or a quantity, not a price.
    return amount >= 1000 && amount <= 5_000_000 ? amount : 0;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const inline = price(line);

    // Either "Klipping 8.900 kr." on one line, or a name then a price beneath.
    let name = '';
    let amount = 0;

    if (inline > 0) {
      name = line.replace(/(\d{1,3}(?:[.\s]\d{3})+|\d{4,6})\s*(?:kr\.?|ISK|krónur)/i, '').trim();
      amount = inline;
    } else {
      const next = lines[i + 1] ?? '';
      const below = price(next);
      if (below > 0 && next.replace(/[\d.,\s]|kr\.?|ISK|krónur/gi, '').length === 0) {
        name = line;
        amount = below;
      }
    }

    name = name.replace(/[\s·:—–-]+$/, '').trim();
    if (!name || amount === 0) continue;
    if (name.length < 2 || name.length > 70) continue;

    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, priceIsk: amount });
    if (out.length >= 40) break;
  }

  return out;
}

function extractSocials(html: string): string[] {
  const hosts = /facebook\.com|instagram\.com|tiktok\.com|linkedin\.com|youtube\.com/i;
  const found = new Set<string>();

  for (const match of html.matchAll(/href\s*=\s*["'](https?:\/\/[^"']+)["']/gi)) {
    const url = match[1]!;
    if (!hosts.test(url)) continue;
    // Strip tracking and trailing slashes so duplicates collapse.
    found.add(url.split('?')[0]!.replace(/\/+$/, ''));
    if (found.size >= 6) break;
  }
  return [...found];
}

/** Parses a fetched page. Exported so it can be tested without a network call. */
export function parseSite(html: string, url: string): ImportedSite {
  const lines = visibleText(html);
  const notes: string[] = [];

  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '')
    .replace(/\s+/g, ' ')
    .trim();

  const description =
    metaContent(html, /<meta[^>]+name\s*=\s*["']description["'][^>]*>/i) ||
    metaContent(html, /<meta[^>]+property\s*=\s*["']og:description["'][^>]*>/i);

  // The longest paragraph is nearly always the "about us" text; navigation and
  // button labels are short, and this avoids having to identify the section.
  const prose = lines
    .filter((line) => line.length >= 90 && /[.!?]/.test(line))
    .sort((a, b) => b.length - a.length);

  const phones = lines
    .flatMap((line) => line.match(/(?:\+354[\s-]?)?\d{3}[\s-]?\d{4}/g) ?? [])
    .map((raw) => normalizePhone(raw))
    .filter((result) => result.valid);

  const emails = [...html.matchAll(/mailto:([^"'?\s>]+)/gi)].map((match) => decodeEntities(match[1]!));
  const inlineEmails = lines.flatMap((line) => line.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) ?? []);
  const email = [...emails, ...inlineEmails].find((candidate) => isValidEmail(candidate)) ?? '';

  const brandColor = extractBrandColor(html);
  if (!brandColor) notes.push('Fann engan skýran einkennislit — nota lit fagsins.');

  const services = extractServices(lines);
  if (services.length === 0) notes.push('Fann enga verðskrá á síðunni.');

  const socials = extractSocials(html);

  return {
    url,
    title,
    tagline: (description || prose[1] || '').slice(0, 200),
    about: (prose[0] ?? '').slice(0, 1200),
    brandColor,
    phone: phones[0]?.e164 ?? '',
    email,
    services,
    socials,
    notes,
  };
}

/**
 * Fetches and reads a site.
 *
 * Only the domain the operator has recorded for this tenant is ever fetched,
 * once, on an explicit click.
 */
export async function importSite(domain: string): Promise<ImportedSite | null> {
  const clean = domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!clean || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(clean)) return null;

  const url = `https://${clean}/`;

  try {
    const response = await fetch(url, {
      headers: {
        'user-agent': 'RafraenThjonusta/1.0 (+vefsidugerd fyrir vidskiptavin)',
        accept: 'text/html',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) {
      logger.warn('Núverandi vefsíða svaraði ekki', { url, status: response.status });
      return null;
    }

    const type = response.headers.get('content-type') ?? '';
    if (!/text\/html/i.test(type)) {
      logger.warn('Slóðin skilaði ekki HTML', { url, type });
      return null;
    }

    const body = await response.text();
    return parseSite(body.slice(0, MAX_BYTES), response.url || url);
  } catch (error) {
    logger.warn('Innflutningur af núverandi vefsíðu mistókst', { url, error: String(error) });
    return null;
  }
}
