/**
 * ISNIC lookup — the domain, and the contact details attached to it.
 *
 * Fyrirtækjaskrá knows who a company legally is but not how to reach it. The
 * .is registry knows the opposite: a domain's WHOIS record carries the phone
 * number and email its registrant published for exactly this purpose.
 *
 * ISNIC can only be searched by domain, never by kennitala, so the domain has
 * to be guessed from the registered company name and then confirmed. The
 * confirmation is the important half: `osp.is` might belong to someone with no
 * connection to Hárgreiðslustofan Ösp, and copying a stranger's phone number
 * into an onboarding form — and from there onto a published website — is the
 * failure this module exists to prevent. A record whose registrant name does
 * not match the company is discarded.
 */

import { logger } from '../../core/logger.ts';
import { slugify } from '../../core/ids.ts';

const WHOIS = 'https://www.isnic.is/en/whois/search?query=';

export interface DomainRecord {
  domain: string;
  registrantName: string;
  email: string;
  phone: string;
  address: string;
  postcode: string;
  city: string;
  registered: string;
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

function textLines(html: string): string[] {
  return html
    .replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, '\n')
    .split('\n')
    .map((line) => decodeEntities(line).replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0);
}

/** ISNIC renders each field as a label row followed by its value row. */
function after(lines: string[], label: string): string {
  const index = lines.indexOf(label);
  if (index === -1) return '';
  return lines[index + 1] ?? '';
}

/** Exported for testing against saved pages. */
export function parseWhoisPage(html: string, domain: string): DomainRecord | null {
  const lines = textLines(html);

  // An unregistered domain renders an offer to buy it, not a record.
  if (lines.some((line) => /is available$/i.test(line))) return null;

  const registrantName = after(lines, 'Registrant name');
  if (!registrantName) return null;

  const email = after(lines, 'E-mail');
  const phone = after(lines, 'Landline') || after(lines, 'Mobile');

  return {
    domain,
    registrantName,
    // ISNIC masks protected records with a dash rather than omitting the row.
    email: /@/.test(email) ? email : '',
    phone: /\d/.test(phone) ? phone : '',
    address: after(lines, 'Address'),
    postcode: after(lines, 'Postal code'),
    city: after(lines, 'City/Municipality'),
    registered: after(lines, 'Registered'),
  };
}

export async function lookupDomain(domain: string): Promise<DomainRecord | null> {
  try {
    const response = await fetch(`${WHOIS}${encodeURIComponent(domain)}`, {
      headers: {
        'user-agent': 'RafraenThjonusta/1.0 (+uppfletting vidskiptavinar)',
        accept: 'text/html',
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) return null;
    return parseWhoisPage(await response.text(), domain);
  } catch (error) {
    logger.warn('ISNIC-uppfletting mistókst', { domain, error: String(error) });
    return null;
  }
}

/** Legal-form suffixes, which are never part of a domain name. */
const LEGAL_SUFFIX = /\s+(ehf|hf|slf|sf|ses|svf|bs|ohf)\.?$/i;

function bareName(name: string): string {
  return name.replace(LEGAL_SUFFIX, '').trim();
}

/**
 * Comparable form of a name: no diacritics, no punctuation, no legal suffix.
 * `slugify` already transliterates Icelandic letters the way domains do.
 */
function comparable(name: string): string {
  return slugify(bareName(name)).replace(/-/g, '');
}

/**
 * Whether a WHOIS registrant plausibly *is* the company.
 *
 * Deliberately strict about direction: containment either way is accepted
 * (a registrant may be "Ösp" for "Hárgreiðslustofan Ösp ehf.", or the longer
 * legal name for a shorter trading name), but a bare shared prefix is not
 * enough — "osp" must not match "ospar".
 */
export function registrantMatches(companyName: string, registrantName: string): boolean {
  const company = comparable(companyName);
  const registrant = comparable(registrantName);
  if (!company || !registrant) return false;
  if (company === registrant) return true;

  // Require the shorter name to be a whole word inside the longer, not a
  // fragment: split the longer into its original words and test those.
  const [shorter, longer] = company.length <= registrant.length
    ? [company, comparable(registrantName)] : [registrant, comparable(companyName)];
  const words = slugify(bareName(company.length <= registrant.length ? registrantName : companyName)).split('-');

  return words.includes(shorter) || longer === shorter;
}

/**
 * Domain candidates derived from a company name, most specific first.
 *
 * Bounded to three: this makes one HTTPS request each, and a longer list turns
 * an onboarding convenience into a scan of the registry.
 */
export function domainCandidates(companyName: string): string[] {
  const slug = slugify(bareName(companyName));
  if (!slug || slug === 'fyrirtaeki') return [];

  const joined = slug.replace(/-/g, '');
  const words = slug.split('-').filter(Boolean);
  const distinctive = words.length > 1 ? words[words.length - 1] : '';

  const candidates = [joined, slug, distinctive]
    .filter((entry): entry is string => typeof entry === 'string' && entry.length >= 3)
    .map((entry) => `${entry}.is`);

  return [...new Set(candidates)].slice(0, 3);
}

/**
 * Finds the company's own domain, or nothing.
 *
 * Stops at the first candidate whose registrant matches, so a company with an
 * obvious domain costs one request.
 */
export async function findCompanyDomain(companyName: string): Promise<DomainRecord | null> {
  for (const candidate of domainCandidates(companyName)) {
    const record = await lookupDomain(candidate);
    if (!record) continue;

    if (registrantMatches(companyName, record.registrantName)) return record;

    logger.info('Lén fannst en skráður eigandi passar ekki — sleppt', {
      candidate,
      registrant: record.registrantName,
      company: companyName,
    });
  }
  return null;
}
