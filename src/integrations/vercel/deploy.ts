/**
 * Publishing generated tenant websites to Vercel.
 *
 * A generated site is one self-contained HTML file plus a sitemap and a
 * robots.txt — no build step, no framework, no assets. That is the one shape
 * of thing serverless hosting is unambiguously good at, so the customer-facing
 * sites go there while the control plane stays on a machine with a disk.
 *
 * The booking widget on those pages calls back to this control plane over
 * HTTPS (`renderSite` takes an `apiBase`), and the public booking API already
 * sends permissive CORS headers, so a site on a Vercel domain can book against
 * it with nothing further to configure.
 *
 * Files are inlined in the deployment request rather than uploaded by hash
 * first. That path is meant for large builds; a site here is tens of kilobytes.
 */

import { IntegrationError } from '../../core/errors.ts';
import { logger } from '../../core/logger.ts';
import { config } from '../../config.ts';

const API = 'https://api.vercel.com';

export interface DeployFile {
  /** Path within the deployment, e.g. `index.html`. No leading slash. */
  file: string;
  data: string;
}

export interface DeployResult {
  /** The deployment's own URL, always available immediately. */
  url: string;
  /** The custom domain, when the tenant has one and it is verified. */
  domain: string;
  deploymentId: string;
  projectName: string;
  state: string;
  /** DNS records the operator still has to add, when a domain is unverified. */
  pendingDns: string[];
}

/**
 * Vercel project names allow lowercase letters, digits and hyphens, up to 100
 * characters. Tenant slugs are already close, but the prefix and the length
 * limit still have to be enforced here.
 */
export function projectNameFor(slug: string): string {
  const prefix = config.vercel.projectPrefix.toLowerCase().replace(/[^a-z0-9-]/g, '');
  const cleaned = slug.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  // A slug is never empty in practice — tenants are created from a name — but
  // falling back to the bare prefix would quietly point every such tenant at
  // one shared project, so it gets its own placeholder instead.
  const base = cleaned || 'vefur';
  const name = prefix ? `${prefix}-${base}` : base;

  // Trimmed again after truncating: the length cap can cut mid-word, and
  // Vercel rejects a project name that ends in a hyphen.
  return name.slice(0, 100).replace(/-+$/, '');
}

function query(): string {
  return config.vercel.teamId ? `?teamId=${encodeURIComponent(config.vercel.teamId)}` : '';
}

async function call(path: string, init: { method: string; body?: unknown }): Promise<unknown> {
  const separator = path.includes('?') ? '&' : query() ? '?' : '';
  const teamParam = config.vercel.teamId ? `${separator}teamId=${encodeURIComponent(config.vercel.teamId)}` : '';

  let response: Response;
  try {
    response = await fetch(`${API}${path}${teamParam}`, {
      method: init.method,
      headers: {
        authorization: `Bearer ${config.vercel.token}`,
        'content-type': 'application/json',
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    throw new IntegrationError('vercel', `Náði ekki sambandi við Vercel: ${String(error)}`);
  }

  const text = await response.text();
  const parsed: unknown = text ? safeJson(text) : null;

  if (!response.ok) {
    // Vercel returns { error: { code, message } }. Keep both: the code is what
    // their documentation is indexed by, the message is what a human reads.
    const detail = parsed as { error?: { code?: string; message?: string } } | null;
    const code = detail?.error?.code ?? String(response.status);
    const message = detail?.error?.message ?? text.slice(0, 300) ?? 'ekkert svar';
    throw new IntegrationError('vercel', `${code}: ${message}`, { status: response.status });
  }

  return parsed;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

interface DeploymentResponse {
  id?: string;
  url?: string;
  readyState?: string;
  status?: string;
  alias?: string[];
}

interface DomainResponse {
  name?: string;
  verified?: boolean;
  verification?: Array<{ type?: string; domain?: string; value?: string; reason?: string }>;
}

/**
 * Creates a production deployment for one tenant site.
 *
 * The project is created implicitly by the first deployment that names it, so
 * there is no separate "create project" step to keep in sync.
 */
export async function deploySite(input: {
  slug: string;
  files: DeployFile[];
  domain?: string;
}): Promise<DeployResult> {
  if (!config.vercel.enabled) {
    throw new IntegrationError('vercel', 'VERCEL_TOKEN er ekki stillt.');
  }
  if (input.files.length === 0) {
    throw new IntegrationError('vercel', 'Engar skrár til að birta.');
  }

  const projectName = projectNameFor(input.slug);

  const deployment = (await call('/v13/deployments?skipAutoDetectionConfirmation=1', {
    method: 'POST',
    body: {
      name: projectName,
      project: projectName,
      target: 'production',
      files: input.files,
      // A folder of static files, explicitly: without this Vercel tries to
      // detect a framework and can decide the site needs a build step.
      projectSettings: {
        framework: null,
        buildCommand: null,
        installCommand: null,
        outputDirectory: null,
      },
    },
  })) as DeploymentResponse;

  const deploymentId = deployment.id ?? '';
  const url = deployment.url ? `https://${deployment.url}` : '';
  const state = deployment.readyState ?? deployment.status ?? 'UNKNOWN';

  let domain = '';
  const pendingDns: string[] = [];

  if (input.domain) {
    const attached = await attachDomain(projectName, input.domain);
    if (attached.verified) {
      domain = `https://${input.domain}`;
    } else {
      pendingDns.push(...attached.records);
    }
  }

  logger.info('Vefsíða birt á Vercel', { projectName, deploymentId, state, domain: input.domain ?? '' });

  return { url, domain, deploymentId, projectName, state, pendingDns };
}

/**
 * Points a custom domain at the project.
 *
 * A domain that is already attached is not an error worth surfacing — the
 * operator publishing a second time means the same thing they meant the first
 * time — so that one case is swallowed and the current status read back.
 */
async function attachDomain(projectName: string, domain: string): Promise<{ verified: boolean; records: string[] }> {
  let result: DomainResponse;

  try {
    result = (await call(`/v10/projects/${encodeURIComponent(projectName)}/domains`, {
      method: 'POST',
      body: { name: domain },
    })) as DomainResponse;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/domain_already_in_use|already exists|400/i.test(message)) throw error;

    result = (await call(
      `/v9/projects/${encodeURIComponent(projectName)}/domains/${encodeURIComponent(domain)}`,
      { method: 'GET' },
    )) as DomainResponse;
  }

  if (result.verified) return { verified: true, records: [] };

  const records = (result.verification ?? []).map((entry) =>
    `${entry.type ?? 'TXT'} ${entry.domain ?? domain} → ${entry.value ?? ''}`.trim(),
  );

  // No challenge listed means Vercel is waiting on the apex A record or the
  // CNAME rather than on a TXT proof.
  if (records.length === 0) {
    records.push(`A ${domain} → 76.76.21.21`, `CNAME www.${domain} → cname.vercel-dns.com`);
  }

  return { verified: false, records };
}
