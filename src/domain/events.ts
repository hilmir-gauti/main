/**
 * Domain event bus.
 *
 * The booking module must not import the Google Calendar client, the mailer or
 * the push sender — that would make the core logic untestable without network
 * stubs and would create import cycles (notifications need booking data).
 * Instead bookings emit events, and `src/integrations/subscribers.ts` wires
 * handlers at startup.
 *
 * Handlers are fire-and-forget: a failing calendar sync must never roll back a
 * booking the customer has already been told is confirmed. Failures are logged
 * and, where it matters, retried by the background worker.
 */

import { logger } from '../core/logger.ts';
import type { BookingView } from './types.ts';

export interface DomainEvents {
  'booking.created': { booking: BookingView };
  'booking.confirmed': { booking: BookingView };
  'booking.cancelled': { booking: BookingView; reason: string; cancelledBy: 'vidskiptavinur' | 'fyrirtaeki' | 'kerfi' };
  'booking.rescheduled': { booking: BookingView; previousStartsAt: number };
  'booking.reminder': { booking: BookingView };
  'booking.completed': { booking: BookingView };
  'tenant.provisioned': { tenantId: string };
  'call.finished': { callId: string; tenantId: string | null };
}

type EventName = keyof DomainEvents;
type Handler<E extends EventName> = (payload: DomainEvents[E]) => void | Promise<void>;

const handlers = new Map<EventName, Array<Handler<EventName>>>();

export function on<E extends EventName>(event: E, handler: Handler<E>): () => void {
  const list = handlers.get(event) ?? [];
  list.push(handler as Handler<EventName>);
  handlers.set(event, list);

  return () => {
    const current = handlers.get(event);
    if (!current) return;
    const index = current.indexOf(handler as Handler<EventName>);
    if (index >= 0) current.splice(index, 1);
  };
}

/**
 * Emits an event without awaiting its handlers. Returns a promise that
 * resolves when all handlers settle, which the test suite awaits and
 * production code ignores.
 */
export function emit<E extends EventName>(event: E, payload: DomainEvents[E]): Promise<void> {
  const list = handlers.get(event);
  if (!list || list.length === 0) return Promise.resolve();

  const results = list.map(async (handler) => {
    try {
      await handler(payload);
    } catch (error) {
      logger.error('Villa í viðbragði við atburði', { event, error });
    }
  });

  return Promise.all(results).then(() => undefined);
}

/** Test helper — removes every registered handler. */
export function clearHandlers(): void {
  handlers.clear();
}
