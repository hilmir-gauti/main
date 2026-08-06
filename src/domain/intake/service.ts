/**
 * Ties intake answers to the rest of the booking domain:
 * resolving which catalogue service the answers point at, adjusting the
 * estimated duration, and rendering answers for humans.
 */

import { fromJson, get, run, toJson } from '../../core/db.ts';
import { listServices } from '../catalog.ts';
import { getTenantOrThrow } from '../tenants.ts';
import type { Service } from '../types.ts';
import { flowForIndustry } from './flows.ts';
import {
  estimatedExtraMinutes,
  renderAnswers,
  suggestedServiceName,
  validateIntake,
  type IntakeAnswers,
  type IntakeFlow,
  type RenderedAnswer,
} from './schema.ts';

/** The flow a tenant's customers see, derived from its industry. */
export function flowForTenant(tenantId: string): IntakeFlow {
  return flowForIndustry(getTenantOrThrow(tenantId).industry);
}

/**
 * Matches an answer's `serviceHint` to one of the tenant's real services.
 *
 * Hints are matched loosely (case- and accent-insensitive substring) because
 * the operator renames preset services constantly — "Smurþjónusta" becomes
 * "Smurning og sía". A miss is not an error: the customer simply picks from
 * the service list instead.
 */
export function resolveService(tenantId: string, answers: IntakeAnswers): Service | null {
  const flow = flowForTenant(tenantId);
  const hint = suggestedServiceName(flow, answers);
  if (!hint) return null;

  const services = listServices(tenantId, { publicOnly: true });
  const normalise = (value: string) =>
    value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');

  const target = normalise(hint);

  return (
    services.find((service) => normalise(service.name) === target) ??
    services.find((service) => normalise(service.name).includes(target) || target.includes(normalise(service.name))) ??
    null
  );
}

export interface PreparedIntake {
  valid: boolean;
  errors: Record<string, string>;
  answers: IntakeAnswers;
  /** Service implied by the answers, if any. */
  service: Service | null;
  /** Extra minutes the answers imply on top of the service's base duration. */
  extraMinutes: number;
}

/** Validates submitted answers and derives everything the booking needs. */
export function prepareIntake(tenantId: string, rawAnswers: IntakeAnswers): PreparedIntake {
  const flow = flowForTenant(tenantId);
  const result = validateIntake(flow, rawAnswers);

  return {
    valid: result.valid,
    errors: result.errors,
    answers: result.cleaned,
    service: result.valid ? resolveService(tenantId, result.cleaned) : null,
    extraMinutes: estimatedExtraMinutes(flow, result.cleaned),
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function saveBookingIntake(bookingId: string, industry: string, answers: IntakeAnswers): void {
  run('UPDATE booking SET intake = ?, intake_flow = ? WHERE id = ?', toJson(answers), industry, bookingId);
}

export function getBookingIntake(bookingId: string): { answers: IntakeAnswers; flow: IntakeFlow | null } {
  const row = get<{ intake: string; intake_flow: string }>(
    'SELECT intake, intake_flow FROM booking WHERE id = ?',
    bookingId,
  );
  if (!row) return { answers: {}, flow: null };

  return {
    answers: fromJson<IntakeAnswers>(row.intake, {}),
    flow: row.intake_flow ? flowForIndustry(row.intake_flow) : null,
  };
}

/** Label/value pairs for the admin console, emails and calendar events. */
export function bookingAnswerSummary(bookingId: string): RenderedAnswer[] {
  const { answers, flow } = getBookingIntake(bookingId);
  return renderAnswers(flow, answers);
}

/** Compact one-line summary for list views and push notifications. */
export function intakeHeadline(bookingId: string, maxLength = 90): string {
  const rendered = bookingAnswerSummary(bookingId);
  if (rendered.length === 0) return '';

  // Prefer the answers that identify the job: a plate, a symptom, a style.
  const priority = ['Bílnúmer', 'Hvaða þjónustu þarftu?', 'Hvað tekurðu eftir?', 'Hvaða einkenni tekurðu eftir?'];
  const ordered = [
    ...rendered.filter((entry) => priority.includes(entry.label)),
    ...rendered.filter((entry) => !priority.includes(entry.label)),
  ];

  const text = ordered.map((entry) => entry.value).join(' · ');
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}
