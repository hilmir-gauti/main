/**
 * Email provisioning for a tenant's own domain.
 *
 * The platform cannot create a Google Workspace or Proton account on someone's
 * behalf — both require a human to accept terms and pay. What it *can* do is
 * remove every other piece of friction: produce the exact DNS records to paste
 * into the registrar, then check them live until they resolve, and tell the
 * operator precisely which record is still wrong.
 *
 * That is the difference between "set up email for the client" taking an hour
 * of guesswork and taking five minutes of copy-paste.
 */

import { promises as dns } from 'node:dns';

import { logger } from '../../core/logger.ts';

export type EmailProvider = 'google' | 'proton' | 'annad';

export interface DnsRecord {
  type: 'MX' | 'TXT' | 'CNAME';
  /** Host relative to the domain; '@' means the domain itself. */
  host: string;
  value: string;
  priority?: number;
  /** Explains the record's purpose in the admin UI. */
  purpose: string;
  /**
   * Records whose value is issued by the provider (DKIM keys, verification
   * tokens) cannot be generated here — the operator pastes them in.
   */
  providerSupplied?: boolean;
}

export interface EmailPlan {
  provider: EmailProvider;
  domain: string;
  label: string;
  /** Ordered steps the operator performs in the provider's console. */
  steps: string[];
  records: DnsRecord[];
  /** Suggested first mailboxes for this kind of business. */
  suggestedMailboxes: string[];
  docsUrl: string;
}

const DMARC_POLICY = 'v=DMARC1; p=quarantine; pct=100; adkim=s; aspf=s';

/**
 * Builds the DNS plan for a domain.
 *
 * SPF uses `~all` (softfail) rather than `-all` because a small business
 * almost always ends up sending from somewhere unexpected — an accounting
 * package, a booking widget — and a hard fail silently destroys those mails.
 * DMARC is set to `quarantine`, which gets the security benefit without
 * bouncing legitimate stragglers outright.
 */
export function buildEmailPlan(provider: EmailProvider, domain: string, options: { dmarcReportTo?: string } = {}): EmailPlan {
  const clean = domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  const dmarcValue = options.dmarcReportTo
    ? `${DMARC_POLICY}; rua=mailto:${options.dmarcReportTo}`
    : DMARC_POLICY;

  if (provider === 'google') {
    return {
      provider,
      domain: clean,
      label: 'Google Workspace',
      docsUrl: 'https://support.google.com/a/answer/140034',
      suggestedMailboxes: ['info', 'bokanir', 'reikningar'],
      steps: [
        'Stofnaðu Google Workspace reikning á workspace.google.com og veldu lénið hér að neðan.',
        'Staðfestu eignarhald á léninu með TXT-færslunni sem Google gefur upp.',
        'Bættu MX-færslunni við hjá lénaskránni (t.d. ISNIC eða þar sem lénið er skráð).',
        'Kveiktu á DKIM í Google Admin (Apps → Gmail → Authenticate email) og settu inn lykilinn sem birtist.',
        'Bíddu eftir að DNS uppfærist — það tekur yfirleitt 15 mínútur til 4 klukkustundir.',
      ],
      records: [
        {
          type: 'MX', host: '@', value: 'smtp.google.com', priority: 1,
          purpose: 'Beinir öllum innkomandi pósti til Google.',
        },
        {
          type: 'TXT', host: '@', value: 'v=spf1 include:_spf.google.com ~all',
          purpose: 'SPF — leyfir Google að senda póst fyrir hönd lénsins.',
        },
        {
          type: 'TXT', host: 'google._domainkey', value: '', providerSupplied: true,
          purpose: 'DKIM — undirritar útsendan póst. Lykillinn kemur úr Google Admin.',
        },
        {
          type: 'TXT', host: '_dmarc', value: dmarcValue,
          purpose: 'DMARC — segir móttakendum hvað gera skal ef póstur stenst ekki auðkenningu.',
        },
      ],
    };
  }

  if (provider === 'proton') {
    return {
      provider,
      domain: clean,
      label: 'Proton Mail',
      docsUrl: 'https://proton.me/support/custom-domain',
      suggestedMailboxes: ['info', 'bokanir'],
      steps: [
        'Stofnaðu Proton Mail áskrift sem styður eigin lén (Mail Plus eða hærra).',
        'Bættu léninu við í Proton (Settings → Domain names) og afritaðu staðfestingarkóðann.',
        'Settu inn TXT-staðfestingarfærsluna hjá lénaskránni.',
        'Bættu við MX-færslunum tveimur.',
        'Afritaðu CNAME-færslurnar þrjár fyrir DKIM úr Proton — þær innihalda auðkenni sem er einstakt fyrir þitt lén.',
        'Að lokum: settu inn SPF og DMARC.',
      ],
      records: [
        {
          type: 'TXT', host: '@', value: 'protonmail-verification=', providerSupplied: true,
          purpose: 'Staðfestir eignarhald á léninu. Kóðinn kemur úr Proton.',
        },
        {
          type: 'MX', host: '@', value: 'mail.protonmail.ch', priority: 10,
          purpose: 'Aðal-póstþjónn Proton.',
        },
        {
          type: 'MX', host: '@', value: 'mailsec.protonmail.ch', priority: 20,
          purpose: 'Varaþjónn ef sá fyrri svarar ekki.',
        },
        {
          type: 'TXT', host: '@', value: 'v=spf1 include:_spf.protonmail.ch ~all',
          purpose: 'SPF — leyfir Proton að senda póst fyrir hönd lénsins.',
        },
        {
          type: 'CNAME', host: 'protonmail._domainkey', value: '', providerSupplied: true,
          purpose: 'DKIM-lykill 1 af 3. Gildið kemur úr Proton.',
        },
        {
          type: 'CNAME', host: 'protonmail2._domainkey', value: '', providerSupplied: true,
          purpose: 'DKIM-lykill 2 af 3.',
        },
        {
          type: 'CNAME', host: 'protonmail3._domainkey', value: '', providerSupplied: true,
          purpose: 'DKIM-lykill 3 af 3.',
        },
        {
          type: 'TXT', host: '_dmarc', value: dmarcValue,
          purpose: 'DMARC — stefna um meðhöndlun ósannvottaðs pósts.',
        },
      ],
    };
  }

  return {
    provider: 'annad',
    domain: clean,
    label: 'Annar póstþjónustuaðili',
    docsUrl: '',
    suggestedMailboxes: ['info'],
    steps: [
      'Fáðu MX-, SPF- og DKIM-færslur frá þjónustuaðilanum.',
      'Settu þær inn hjá lénaskránni.',
      'Bættu við DMARC-færslunni hér að neðan — hún er eins óháð þjónustuaðila.',
    ],
    records: [
      {
        type: 'TXT', host: '_dmarc', value: dmarcValue,
        purpose: 'DMARC — stefna um meðhöndlun ósannvottaðs pósts.',
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Live verification
// ---------------------------------------------------------------------------

export interface RecordCheck {
  record: DnsRecord;
  status: 'i_lagi' | 'vantar' | 'rangt' | 'bidur_gilda';
  found: string[];
  message: string;
}

export interface VerificationResult {
  domain: string;
  checkedAt: number;
  allGood: boolean;
  checks: RecordCheck[];
}

function fqdn(host: string, domain: string): string {
  return host === '@' ? domain : `${host}.${domain}`;
}

/**
 * Resolves each record and compares it with the plan.
 *
 * DNS lookups fail in all sorts of mundane ways (NXDOMAIN while propagating,
 * SERVFAIL from a flaky resolver), so a failure is reported as "vantar" rather
 * than raised — the operator is looking at a checklist, not debugging DNS.
 */
export async function verifyEmailDns(plan: EmailPlan): Promise<VerificationResult> {
  const checks: RecordCheck[] = [];

  for (const record of plan.records) {
    if (record.providerSupplied && !record.value) {
      checks.push({
        record,
        status: 'bidur_gilda',
        found: [],
        message: 'Bíður eftir gildi frá þjónustuaðila — afritaðu það úr stjórnborði þeirra.',
      });
      continue;
    }

    const name = fqdn(record.host, plan.domain);

    try {
      if (record.type === 'MX') {
        const records = await dns.resolveMx(name);
        const found = records.map((r) => `${r.priority} ${r.exchange.replace(/\.$/, '')}`);
        const matched = records.some((r) => r.exchange.replace(/\.$/, '').toLowerCase() === record.value.toLowerCase());
        checks.push({
          record,
          status: matched ? 'i_lagi' : records.length > 0 ? 'rangt' : 'vantar',
          found,
          message: matched
            ? 'Færslan er komin í gildi.'
            : records.length > 0
              ? 'Aðrar MX-færslur fundust. Fjarlægðu gamlar færslur svo póstur rati rétt.'
              : 'Engin MX-færsla fannst.',
        });
        continue;
      }

      if (record.type === 'TXT') {
        const records = await dns.resolveTxt(name);
        const flattened = records.map((chunks) => chunks.join(''));
        // SPF and DMARC are compared on their leading tag, since the tail
        // legitimately varies (extra includes, report addresses).
        const prefix = record.value.split(';')[0]!.trim().toLowerCase();
        const matched = flattened.some((value) => value.trim().toLowerCase().startsWith(prefix));
        checks.push({
          record,
          status: matched ? 'i_lagi' : flattened.length > 0 ? 'rangt' : 'vantar',
          found: flattened,
          message: matched
            ? 'Færslan er komin í gildi.'
            : flattened.length > 0
              ? 'TXT-færslur fundust en engin sem passar.'
              : 'Engin TXT-færsla fannst.',
        });
        continue;
      }

      const records = await dns.resolveCname(name);
      const matched = records.some((value) => value.replace(/\.$/, '').toLowerCase() === record.value.replace(/\.$/, '').toLowerCase());
      checks.push({
        record,
        status: matched ? 'i_lagi' : records.length > 0 ? 'rangt' : 'vantar',
        found: records,
        message: matched ? 'Færslan er komin í gildi.' : 'CNAME passar ekki við væntanlegt gildi.',
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      checks.push({
        record,
        status: 'vantar',
        found: [],
        message:
          code === 'ENOTFOUND' || code === 'ENODATA'
            ? 'Færslan fannst ekki. Hún gæti verið að taka gildi — DNS tekur oft nokkrar klukkustundir.'
            : `Uppfletting mistókst (${code || 'óþekkt villa'}).`,
      });
    }
  }

  const allGood = checks.every((check) => check.status === 'i_lagi');
  logger.info('DNS-athugun keyrð', { domain: plan.domain, allGood, records: checks.length });

  return { domain: plan.domain, checkedAt: Date.now(), allGood, checks };
}

/** Checks whether a domain already has mail configured, before we change it. */
export async function detectExistingMail(domain: string): Promise<{ hasMx: boolean; provider: string; records: string[] }> {
  try {
    const records = await dns.resolveMx(domain);
    const hosts = records.map((r) => r.exchange.toLowerCase());
    const joined = hosts.join(' ');

    const provider = joined.includes('google') ? 'Google'
      : joined.includes('protonmail') ? 'Proton'
      : joined.includes('outlook') || joined.includes('microsoft') ? 'Microsoft 365'
      : joined.includes('zoho') ? 'Zoho'
      : hosts.length > 0 ? 'Óþekktur' : '';

    return { hasMx: hosts.length > 0, provider, records: hosts };
  } catch {
    return { hasMx: false, provider: '', records: [] };
  }
}

/** Suggested addresses like `bokanir@stofan.is`, ready to create. */
export function suggestedAddresses(plan: EmailPlan): string[] {
  return plan.suggestedMailboxes.map((box) => `${box}@${plan.domain}`);
}
