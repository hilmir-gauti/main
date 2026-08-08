/**
 * Onboarding pipeline.
 *
 * When the operator finishes the wizard this runs everything that can be
 * automated — services, opening hours, staff, feature flags, website builds —
 * and turns everything that cannot into a concrete checklist item with the
 * exact values needed to complete it.
 *
 * The distinction matters: "set up email" is not a task, it is a wish.
 * "Paste these four DNS records at the registrar, then press Check" is a task.
 */

import { all, fromJson, get, run, toJson, transaction } from '../core/db.ts';
import { id } from '../core/ids.ts';
import { logger } from '../core/logger.ts';
import { config } from '../config.ts';
import { applyPresetServices, createStaff, listServices, listStaff, updateService } from './catalog.ts';
import { emit } from './events.ts';
import { industryPreset } from './industries.ts';
import { applyPresetHours } from './schedule.ts';
import { applyPresetProducts, listProducts } from './shop/products.ts';
import { getTenantOrThrow, setFeatures, updateTenant } from './tenants.ts';
import type { Feature } from './types.ts';
import { buildEmailPlan, type EmailProvider } from '../integrations/email/provisioning.ts';
import { createPairingInvite } from '../integrations/push/devices.ts';
import { webhookUrls } from '../integrations/twilio.ts';
import { generateVariants } from '../website/generator.ts';

export type TaskStatus = 'bidur' | 'i_vinnslu' | 'lokid' | 'stopp' | 'sleppt';

export interface ProvisioningTask {
  id: string;
  tenantId: string;
  key: string;
  title: string;
  description: string;
  status: TaskStatus;
  detail: string;
  payload: Record<string, unknown>;
  requiresOperator: boolean;
  sortOrder: number;
  completedAt: number | null;
}

interface TaskRow {
  id: string; tenant_id: string; key: string; title: string; description: string;
  status: string; detail: string; payload: string; requires_operator: number;
  sort_order: number; completed_at: number | null;
}

function toTask(row: TaskRow): ProvisioningTask {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    key: row.key,
    title: row.title,
    description: row.description,
    status: row.status as TaskStatus,
    detail: row.detail,
    payload: fromJson<Record<string, unknown>>(row.payload, {}),
    requiresOperator: row.requires_operator === 1,
    sortOrder: row.sort_order,
    completedAt: row.completed_at,
  };
}

export function upsertTask(
  tenantId: string,
  input: {
    key: string;
    title: string;
    description?: string;
    status?: TaskStatus;
    detail?: string;
    payload?: Record<string, unknown>;
    requiresOperator?: boolean;
    sortOrder?: number;
  },
): void {
  const now = Date.now();
  run(
    `INSERT INTO provisioning_task (
       id, tenant_id, key, title, description, status, detail, payload,
       requires_operator, sort_order, created_at, updated_at, completed_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(tenant_id, key) DO UPDATE SET
       title = excluded.title,
       description = excluded.description,
       -- A task the operator already finished is never reopened by a re-run.
       status = CASE WHEN provisioning_task.status = 'lokid' THEN 'lokid' ELSE excluded.status END,
       detail = excluded.detail,
       payload = excluded.payload,
       requires_operator = excluded.requires_operator,
       sort_order = excluded.sort_order,
       updated_at = excluded.updated_at`,
    id('verk'),
    tenantId,
    input.key,
    input.title,
    input.description ?? '',
    input.status ?? 'bidur',
    input.detail ?? '',
    toJson(input.payload ?? {}),
    input.requiresOperator ?? false,
    input.sortOrder ?? 0,
    now,
    now,
    input.status === 'lokid' ? now : null,
  );
}

export function listTasks(tenantId: string): ProvisioningTask[] {
  return all<TaskRow>(
    'SELECT * FROM provisioning_task WHERE tenant_id = ? ORDER BY sort_order, title',
    tenantId,
  ).map(toTask);
}

export function getTask(tenantId: string, key: string): ProvisioningTask | null {
  const row = get<TaskRow>('SELECT * FROM provisioning_task WHERE tenant_id = ? AND key = ?', tenantId, key);
  return row ? toTask(row) : null;
}

export function setTaskStatus(tenantId: string, key: string, status: TaskStatus, detail?: string): void {
  run(
    `UPDATE provisioning_task
        SET status = ?, detail = COALESCE(?, detail), updated_at = ?,
            completed_at = CASE WHEN ? = 'lokid' THEN ? ELSE NULL END
      WHERE tenant_id = ? AND key = ?`,
    status,
    detail ?? null,
    Date.now(),
    status,
    Date.now(),
    tenantId,
    key,
  );
}

export interface ProvisioningProgress {
  total: number;
  done: number;
  blocked: number;
  waitingOnOperator: number;
  percent: number;
}

export function progress(tenantId: string): ProvisioningProgress {
  const tasks = listTasks(tenantId).filter((task) => task.status !== 'sleppt');
  const done = tasks.filter((task) => task.status === 'lokid').length;
  const blocked = tasks.filter((task) => task.status === 'stopp').length;
  const waiting = tasks.filter((task) => task.requiresOperator && task.status !== 'lokid').length;

  return {
    total: tasks.length,
    done,
    blocked,
    waitingOnOperator: waiting,
    percent: tasks.length === 0 ? 0 : Math.round((done / tasks.length) * 100),
  };
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

export interface ProvisionInput {
  tenantId: string;
  features: Feature[];
  /** Answers to the industry-specific wizard questions. */
  answers?: Record<string, string>;
  emailProvider?: EmailProvider;
  /** Names typed into the wizard; blank entries are ignored. */
  staffNames?: string[];
  /** Concurrent capacity for trades without named staff (bays, chairs). */
  capacity?: number;
  /** Skip regenerating the catalogue on a re-run. */
  keepCatalogue?: boolean;
}

export interface ProvisionResult {
  tasksCreated: number;
  servicesCreated: number;
  productsCreated: number;
  staffCreated: number;
  variantsBuilt: number;
  pairingCode: string | null;
}

/**
 * Runs onboarding. Safe to re-run: completed tasks stay completed, and the
 * catalogue is only seeded when it is empty.
 */
export function provisionTenant(input: ProvisionInput): ProvisionResult {
  const tenant = getTenantOrThrow(input.tenantId);
  const preset = industryPreset(tenant.industry);
  const features = new Set(input.features);

  let servicesCreated = 0;
  let productsCreated = 0;
  let staffCreated = 0;
  let pairingCode: string | null = null;

  transaction(() => {
    setFeatures(tenant.id, [...features]);

    // --- Catalogue -------------------------------------------------------
    if (!input.keepCatalogue && listServices(tenant.id, { includeInactive: true }).length === 0) {
      servicesCreated = applyPresetServices(tenant.id, preset.services).length;
      applyPresetHours(tenant.id, preset.hours);
    }

    // The starting shelf for trades that sell objects. Priced and described so
    // the operator edits real listings rather than filling in empty ones.
    if (
      features.has('vefverslun')
      && !input.keepCatalogue
      && (preset.products?.length ?? 0) > 0
      && listProducts(tenant.id, { includeInactive: true }).length === 0
    ) {
      productsCreated = applyPresetProducts(tenant.id, preset.products ?? []).length;
    }

    // For trades without named staff, capacity is a property of the shop
    // (how many bays), so it is applied uniformly across services.
    if (!preset.staffled && input.capacity && input.capacity > 0) {
      for (const service of listServices(tenant.id, { includeInactive: true })) {
        updateService(service.id, { capacity: input.capacity, requiresStaff: false });
      }
    }

    // --- Staff -----------------------------------------------------------
    const names = (input.staffNames ?? []).map((name) => name.trim()).filter(Boolean);
    if (names.length > 0 && listStaff(tenant.id, { includeInactive: true }).length === 0) {
      for (const name of names) {
        createStaff(tenant.id, { name, title: preset.defaultStaffTitle });
        staffCreated++;
      }
    }

    // --- Checklist -------------------------------------------------------
    let order = 0;

    upsertTask(tenant.id, {
      key: 'grunnur',
      title: 'Grunnuppsetning',
      description: 'Þjónustulisti, opnunartími og eiginleikar skráðir.',
      status: 'lokid',
      detail: `${listServices(tenant.id, { includeInactive: true }).length} þjónustur skráðar.`,
      sortOrder: order++,
    });

    if (features.has('vefsida')) {
      upsertTask(tenant.id, {
        key: 'vefsida',
        title: 'Veldu útlit og birtu vefsíðu',
        description: 'Útlitstillögur hafa verið útbúnar. Skoðaðu þær og veldu þá sem passar.',
        requiresOperator: true,
        payload: { forskodunSlod: `${config.baseUrl}/vidskiptavinir/${tenant.id}/vefur` },
        sortOrder: order++,
      });
    }

    if (features.has('bokanir')) {
      upsertTask(tenant.id, {
        key: 'bokanir',
        title: 'Bókunarkerfi virkt',
        description: 'Netbókanir eru virkar með spurningaflæði fyrir þetta fag.',
        status: 'lokid',
        detail: `Bókunarsíða: ${config.baseUrl}/v/${tenant.slug}`,
        sortOrder: order++,
      });
    }

    if (features.has('vefverslun')) {
      const products = listProducts(tenant.id, { includeInactive: true });
      // Photographs are the one thing this platform cannot generate, and a
      // handmade object does not sell without one — so it is a real task.
      const missingImages = products.filter((product) => !product.imageUrl).length;

      upsertTask(tenant.id, {
        key: 'vefverslun',
        title: 'Settu myndir á vörurnar',
        description: `${products.length} vörur eru komnar í vörulistann. Vörur seljast ekki myndalausar — settu inn slóð á mynd fyrir hverja þeirra.`,
        requiresOperator: missingImages > 0,
        status: missingImages > 0 ? 'bidur' : 'lokid',
        detail: missingImages > 0
          ? `${missingImages} af ${products.length} vörum vantar mynd.`
          : 'Allar vörur eru með mynd.',
        payload: { vorulisti: `${config.baseUrl}/vidskiptavinir/${tenant.id}/verslun` },
        sortOrder: order++,
      });
    }

    if (features.has('google_calendar')) {
      upsertTask(tenant.id, {
        key: 'google_calendar',
        title: 'Tengdu Google dagatal',
        description: 'Viðskiptavinurinn þarf að samþykkja aðgang að dagatalinu sínu.',
        requiresOperator: true,
        detail: config.google.enabled
          ? 'Smelltu á „Tengja dagatal“ á síðu viðskiptavinarins.'
          : 'GOOGLE_CLIENT_ID og GOOGLE_CLIENT_SECRET vantar í stillingar.',
        status: config.google.enabled ? 'bidur' : 'stopp',
        payload: { tengislod: `${config.baseUrl}/vidskiptavinir/${tenant.id}/google/tengja` },
        sortOrder: order++,
      });
    }

    if (features.has('tolvupostur')) {
      const provider = input.emailProvider ?? 'google';
      const domain = tenant.websiteDomain || `${tenant.slug}.is`;
      const plan = buildEmailPlan(provider, domain, { dmarcReportTo: tenant.email || undefined });

      upsertTask(tenant.id, {
        key: 'tolvupostur',
        title: `Settu upp netfang (${plan.label})`,
        description: 'DNS-færslur hafa verið útbúnar. Settu þær inn hjá lénaskránni og keyrðu svo athugun.',
        requiresOperator: true,
        detail: !tenant.websiteDomain
          ? 'Athugið: lén hefur ekki verið skráð á viðskiptavininn — færslurnar miðast við ágiskað lén.'
          : `Lén: ${domain}`,
        payload: {
          provider,
          domain,
          faerslur: plan.records,
          skref: plan.steps,
          netfong: plan.suggestedMailboxes.map((box) => `${box}@${domain}`),
        },
        sortOrder: order++,
      });
    }

    if (features.has('simsvorun')) {
      const hooks = webhookUrls(tenant.id);
      upsertTask(tenant.id, {
        key: 'simsvorun',
        title: 'Settu upp símanúmer',
        description: 'Beindu símanúmerinu á símsvarann okkar, eða kauptu nýtt númer í gegnum Twilio.',
        requiresOperator: true,
        status: config.twilio.enabled ? 'bidur' : 'stopp',
        detail: config.twilio.enabled
          ? 'Límdu slóðirnar hér að neðan inn í Twilio-stjórnborðið.'
          : 'TWILIO_ACCOUNT_SID og TWILIO_AUTH_TOKEN vantar í stillingar.',
        payload: { vefkrokar: hooks, kvedja: tenant.greeting },
        sortOrder: order++,
      });
    }

    if (features.has('sms')) {
      upsertTask(tenant.id, {
        key: 'sms',
        title: 'SMS-áminningar',
        description: `Áminning fer út ${config.booking.reminderHoursBefore} klst. fyrir tíma.`,
        status: config.twilio.enabled ? 'lokid' : 'stopp',
        detail: config.twilio.enabled ? 'Virkt.' : 'Twilio er ekki uppsett — SMS fer í þurrkeyrslu.',
        sortOrder: order++,
      });
    }

    if (features.has('app_tilkynningar')) {
      const invite = createPairingInvite(tenant.id, `Sími — ${tenant.name}`);
      pairingCode = invite.code;

      upsertTask(tenant.id, {
        key: 'app_tilkynningar',
        title: 'Paraðu snjallsíma við appið',
        description: 'Láttu viðskiptavininn setja upp appið og slá inn pörunarkóðann.',
        requiresOperator: true,
        detail: `Kóði: ${invite.code} (rennur út eftir 30 mínútur — hægt er að búa til nýjan hvenær sem er)`,
        payload: { kodi: invite.code, rennurUt: invite.expiresAt },
        sortOrder: order++,
      });
    }

    upsertTask(tenant.id, {
      key: 'yfirferd',
      title: 'Lokayfirferð með viðskiptavini',
      description: 'Farðu yfir vefsíðu, verðskrá, opnunartíma og bókunarflæði áður en farið er í loftið.',
      requiresOperator: true,
      sortOrder: order++,
    });
  });

  // Website builds write to disk, so they run outside the transaction.
  let variantsBuilt = 0;
  if (features.has('vefsida')) {
    try {
      variantsBuilt = generateVariants(tenant.id).length;
    } catch (error) {
      logger.error('Gerð vefútgáfa mistókst', { tenantId: tenant.id, error });
      setTaskStatus(tenant.id, 'vefsida', 'stopp', `Villa við gerð vefsíðu: ${String(error)}`);
    }
  }

  const tasks = listTasks(tenant.id);
  logger.info('Uppsetningu lokið', {
    tenantId: tenant.id,
    features: [...features],
    tasks: tasks.length,
    servicesCreated,
    productsCreated,
    staffCreated,
  });

  void emit('tenant.provisioned', { tenantId: tenant.id });

  return {
    tasksCreated: tasks.length,
    servicesCreated,
    productsCreated,
    staffCreated,
    variantsBuilt,
    pairingCode,
  };
}

/** Moves a tenant from setup to live once the checklist allows it. */
export function activateTenant(tenantId: string): { activated: boolean; blocking: string[] } {
  const tasks = listTasks(tenantId);
  const blocking = tasks
    .filter((task) => task.status === 'stopp')
    .map((task) => task.title);

  if (blocking.length > 0) return { activated: false, blocking };

  updateTenant(tenantId, { status: 'virkur' });
  logger.info('Viðskiptavinur virkjaður', { tenantId });
  return { activated: true, blocking: [] };
}
