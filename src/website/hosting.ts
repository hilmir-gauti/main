/**
 * Putting a published site on external hosting.
 *
 * `publishVariant` writes the site to disk and it is immediately servable from
 * this machine at `/v/:slug`. That stays true whether or not Vercel is
 * configured — hosting is an additional step, never a prerequisite, so a first
 * run with no accounts anywhere still produces a working website.
 *
 * The push is deliberately a separate, explicit action rather than a side
 * effect of choosing a design: it crosses the network, it can fail for reasons
 * that have nothing to do with the site, and the operator should see that
 * failure attached to the thing they asked for.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { get, run } from '../core/db.ts';
import { logger } from '../core/logger.ts';
import { notFound } from '../core/errors.ts';
import { getTenantOrThrow } from '../domain/tenants.ts';
import { deploySite, projectNameFor, type DeployResult } from '../integrations/vercel/deploy.ts';
import { latestBuild } from './generator.ts';

/** The three files `publishVariant` writes. */
const SITE_FILES = ['index.html', 'sitemap.xml', 'robots.txt'] as const;

export interface HostingResult extends DeployResult {
  version: number;
}

/**
 * Pushes the current published build to Vercel.
 *
 * Reads the files back off disk rather than re-rendering: what goes live is
 * then byte-for-byte what the operator previewed and approved, even if a
 * service or an opening hour changed in the minute since.
 */
export async function deployPublishedSite(tenantId: string): Promise<HostingResult> {
  const tenant = getTenantOrThrow(tenantId);
  const build = latestBuild(tenantId);

  if (!build) {
    throw notFound('Engin birt vefsíða til að senda. Veldu útlit fyrst.');
  }

  const directory = dirname(build.path);
  const files = SITE_FILES.map((name) => ({
    file: name,
    data: readFileSync(join(directory, name), 'utf8'),
  }));

  const result = await deploySite({
    slug: tenant.slug,
    files,
    ...(tenant.websiteDomain ? { domain: tenant.websiteDomain } : {}),
  });

  run(
    'UPDATE website_build SET deploy_url = ?, deploy_state = ?, deployed_at = ? WHERE id = ?',
    result.domain || result.url,
    result.state,
    Date.now(),
    build.id,
  );

  logger.info('Vefsíða send á ytri hýsingu', { tenantId, version: build.version, url: result.url });
  return { ...result, version: build.version };
}

export interface HostingStatus {
  url: string;
  state: string;
  deployedAt: number | null;
  projectName: string;
  /** True when the site has changed since it was last pushed. */
  stale: boolean;
}

/** What the website tab shows about external hosting, if anything. */
export function hostingStatus(tenantId: string): HostingStatus | null {
  const tenant = getTenantOrThrow(tenantId);
  const row = get<{ deploy_url: string; deploy_state: string; deployed_at: number | null; built_at: number }>(
    `SELECT deploy_url, deploy_state, deployed_at, built_at
       FROM website_build WHERE tenant_id = ? ORDER BY version DESC LIMIT 1`,
    tenantId,
  );

  if (!row || !row.deploy_url) return null;

  return {
    url: row.deploy_url,
    state: row.deploy_state,
    deployedAt: row.deployed_at,
    projectName: projectNameFor(tenant.slug),
    stale: row.deployed_at !== null && row.built_at > row.deployed_at,
  };
}
