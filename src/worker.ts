/**
 * Background worker.
 *
 * One timer, three jobs: send appointment reminders, pull calendar changes,
 * and tidy up expired rows. A single in-process loop is the right size here —
 * a job queue would add operational surface for work that amounts to a few
 * hundred rows a day.
 *
 * Every tick is guarded: a job that throws is logged and the next tick runs
 * normally, and ticks never overlap.
 */

import { run } from './core/db.ts';
import { logger } from './core/logger.ts';
import { config } from './config.ts';
import { bookingsDueReminder } from './domain/booking/bookings.ts';
import { pruneLoginAttempts, pruneSessions } from './domain/auth.ts';
import { emit } from './domain/events.ts';
import { listTenants } from './domain/tenants.ts';
import { isFeatureEnabled } from './domain/tenants.ts';
import { syncBusyBlocks } from './integrations/google/calendar.ts';

let timer: NodeJS.Timeout | null = null;
let running = false;
let lastCalendarSync = 0;

/** Calendar sync is the expensive job, so it runs every 15 minutes, not every tick. */
const CALENDAR_SYNC_INTERVAL_MS = 15 * 60_000;

export async function tick(now: number = Date.now()): Promise<{ reminders: number; calendars: number }> {
  let reminders = 0;
  let calendars = 0;

  // --- Reminders ---------------------------------------------------------
  try {
    const due = bookingsDueReminder(config.booking.reminderHoursBefore, now);
    for (const booking of due) {
      await emit('booking.reminder', { booking });
      reminders++;
    }
    if (reminders > 0) logger.info('Áminningar sendar', { count: reminders });
  } catch (error) {
    logger.error('Áminningarverk mistókst', { error });
  }

  // --- Calendar sync -----------------------------------------------------
  if (config.google.enabled && now - lastCalendarSync > CALENDAR_SYNC_INTERVAL_MS) {
    lastCalendarSync = now;
    try {
      for (const tenant of listTenants({ status: 'virkur' })) {
        if (!isFeatureEnabled(tenant.id, 'google_calendar')) continue;
        const result = await syncBusyBlocks(tenant.id, { now });
        if (result.imported > 0) calendars++;
      }
    } catch (error) {
      logger.error('Dagatalssamstilling mistókst', { error });
    }
  }

  // --- Housekeeping ------------------------------------------------------
  try {
    pruneSessions();
    pruneLoginAttempts();
    // Busy blocks in the past can never affect availability again.
    run("DELETE FROM external_busy WHERE ends_at < ?", now - 7 * 86_400_000);
  } catch (error) {
    logger.error('Tiltekt mistókst', { error });
  }

  return { reminders, calendars };
}

export function startWorker(): void {
  if (timer) return;

  const intervalMs = Math.max(15, config.booking.workerIntervalSec) * 1000;

  timer = setInterval(() => {
    if (running) {
      logger.warn('Bakgrunnsverk enn í gangi — sleppi þessari umferð');
      return;
    }
    running = true;
    void tick()
      .catch((error) => logger.error('Bakgrunnsverk mistókst', { error }))
      .finally(() => {
        running = false;
      });
  }, intervalMs);

  // Do not hold the process open on shutdown.
  timer.unref();
  logger.info('Bakgrunnsverk ræst', { intervalSec: intervalMs / 1000 });
}

export function stopWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('Bakgrunnsverk stöðvað');
  }
}
