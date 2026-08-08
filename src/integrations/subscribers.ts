/**
 * Wires domain events to side effects.
 *
 * This is the only place that knows both about bookings and about Google,
 * SMTP, Twilio and Expo. Keeping it here means the booking engine stays
 * testable without a single network stub, and adding a channel later touches
 * one file.
 *
 * Handlers are intentionally forgiving: a failed email must not prevent the
 * push notification, so each side effect is awaited independently and its
 * failure is logged rather than propagated.
 */

import { get } from '../core/db.ts';
import { canReceiveSms, formatISK } from '../core/iceland.ts';
import { logger } from '../core/logger.ts';
import { formatDateTimeIs, relativeIs } from '../core/time.ts';
import { config } from '../config.ts';
import { markConfirmationSent, markReminderSent } from '../domain/booking/bookings.ts';
import { getServiceOrThrow } from '../domain/catalog.ts';
import { on } from '../domain/events.ts';
import { intakeHeadline } from '../domain/intake/service.ts';
import { markOrderConfirmationSent, shopSettings } from '../domain/shop/orders.ts';
import { getTenantOrThrow, isFeatureEnabled } from '../domain/tenants.ts';
import type { BookingView } from '../domain/types.ts';
import { pushBooking, removeBookingEvent } from './google/calendar.ts';
import { sendMail } from './email/mailer.ts';
import {
  bookingCancelled,
  bookingConfirmation,
  bookingReminder,
  bookingRescheduled,
  newBookingForOwner,
  newOrderForOwner,
  orderConfirmation,
  orderStatusUpdate,
  voicemailNotification,
} from './email/templates.ts';
import { sendPush } from './push/expo.ts';
import { sendSms } from './twilio.ts';

/** Runs a side effect, logging failures instead of letting them escape. */
async function attempt(label: string, meta: Record<string, unknown>, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    logger.error(`Hliðarverkun mistókst: ${label}`, { ...meta, error: String(error) });
  }
}

function serviceDuration(booking: BookingView): number {
  // The stored span is authoritative: it already includes any extra time the
  // intake answers added, which the service record does not know about.
  return Math.round((booking.endsAt - booking.startsAt) / 60_000);
}

function bookingUrl(booking: BookingView): string {
  return `${config.baseUrl}/vidskiptavinir/${booking.tenantId}/bokanir?bokun=${booking.id}`;
}

export function registerSubscribers(): void {
  // -------------------------------------------------------------------------
  // New booking: tell the business.
  // -------------------------------------------------------------------------
  on('booking.created', async ({ booking }) => {
    const tenant = getTenantOrThrow(booking.tenantId);
    const details = intakeHeadline(booking.id);

    await attempt('push', { bookingId: booking.id }, () =>
      sendPush({
        tenantId: tenant.id,
        kind: 'ny_bokun',
        title: 'Ný bókun',
        body: [
          `${booking.customerName} · ${booking.serviceName}`,
          formatDateTimeIs(booking.startsAt, tenant.timezone),
          details,
        ].filter(Boolean).join('\n'),
        data: { bookingId: booking.id, url: bookingUrl(booking) },
      }),
    );

    // Notify the business by email as well, since push needs a paired phone.
    const recipient = tenant.voicemailEmail || tenant.email;
    if (recipient) {
      const mail = newBookingForOwner(tenant, booking, serviceDuration(booking));
      await attempt('owner-email', { bookingId: booking.id }, () =>
        sendMail({
          tenantId: tenant.id,
          to: recipient,
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
          template: 'ny_bokun_eigandi',
          relatedBookingId: booking.id,
        }),
      );
    }
  });

  // -------------------------------------------------------------------------
  // Confirmed: tell the customer, and mirror to the calendar.
  // -------------------------------------------------------------------------
  on('booking.confirmed', async ({ booking }) => {
    const tenant = getTenantOrThrow(booking.tenantId);

    await attempt('calendar', { bookingId: booking.id }, () => pushBooking(booking));

    // Guard against a double send when a booking is confirmed manually after
    // having been auto-confirmed.
    const already = get<{ confirmation_sent_at: number | null }>(
      'SELECT confirmation_sent_at FROM booking WHERE id = ?',
      booking.id,
    );
    if (already?.confirmation_sent_at) return;

    const duration = serviceDuration(booking);
    let notified = false;

    if (booking.customerEmail) {
      const mail = bookingConfirmation(tenant, booking, duration);
      await attempt('confirmation-email', { bookingId: booking.id }, async () => {
        const result = await sendMail({
          tenantId: tenant.id,
          to: { name: booking.customerName, email: booking.customerEmail },
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
          template: 'stadfesting',
          relatedBookingId: booking.id,
        });
        if (result.status !== 'villa') notified = true;
      });
    }

    if (isFeatureEnabled(tenant.id, 'sms') && canReceiveSms(booking.customerPhone)) {
      await attempt('confirmation-sms', { bookingId: booking.id }, async () => {
        const result = await sendSms({
          tenantId: tenant.id,
          to: booking.customerPhone,
          body:
            `${tenant.name}: Tíminn þinn ${formatDateTimeIs(booking.startsAt, tenant.timezone)} — ${booking.serviceName}. ` +
            `Afbóka: ${config.baseUrl}/afbokun/${booking.cancelToken}`,
          template: 'stadfesting',
          relatedBookingId: booking.id,
        });
        if (result.status !== 'villa') notified = true;
      });
    }

    if (notified) markConfirmationSent(booking.id);
  });

  // -------------------------------------------------------------------------
  // Cancelled.
  // -------------------------------------------------------------------------
  on('booking.cancelled', async ({ booking, reason, cancelledBy }) => {
    const tenant = getTenantOrThrow(booking.tenantId);

    await attempt('calendar-remove', { bookingId: booking.id }, () => removeBookingEvent(booking));

    // Only mail the customer when someone else cancelled on their behalf —
    // a customer who just clicked "cancel" already saw the confirmation page.
    if (booking.customerEmail && cancelledBy !== 'vidskiptavinur') {
      const mail = bookingCancelled(tenant, booking, reason);
      await attempt('cancel-email', { bookingId: booking.id }, () =>
        sendMail({
          tenantId: tenant.id,
          to: { name: booking.customerName, email: booking.customerEmail },
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
          template: 'afbokun',
          relatedBookingId: booking.id,
        }),
      );
    }

    await attempt('push', { bookingId: booking.id }, () =>
      sendPush({
        tenantId: tenant.id,
        kind: 'afbokun',
        title: 'Bókun afbókuð',
        body: `${booking.customerName} · ${booking.serviceName}\n${formatDateTimeIs(booking.startsAt, tenant.timezone)}`,
        data: { bookingId: booking.id },
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Rescheduled.
  // -------------------------------------------------------------------------
  on('booking.rescheduled', async ({ booking, previousStartsAt }) => {
    const tenant = getTenantOrThrow(booking.tenantId);

    await attempt('calendar', { bookingId: booking.id }, () => pushBooking(booking));

    if (booking.customerEmail) {
      const mail = bookingRescheduled(tenant, booking, previousStartsAt, serviceDuration(booking));
      await attempt('reschedule-email', { bookingId: booking.id }, () =>
        sendMail({
          tenantId: tenant.id,
          to: { name: booking.customerName, email: booking.customerEmail },
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
          template: 'faersla',
          relatedBookingId: booking.id,
        }),
      );
    }

    if (isFeatureEnabled(tenant.id, 'sms') && canReceiveSms(booking.customerPhone)) {
      await attempt('reschedule-sms', { bookingId: booking.id }, () =>
        sendSms({
          tenantId: tenant.id,
          to: booking.customerPhone,
          body: `${tenant.name}: Tímanum þínum hefur verið breytt í ${formatDateTimeIs(booking.startsAt, tenant.timezone)}.`,
          template: 'faersla',
          relatedBookingId: booking.id,
        }),
      );
    }
  });

  // -------------------------------------------------------------------------
  // Reminder, raised by the background worker.
  // -------------------------------------------------------------------------
  on('booking.reminder', async ({ booking }) => {
    const tenant = getTenantOrThrow(booking.tenantId);
    const duration = serviceDuration(booking);
    let sent = false;

    if (booking.customerEmail) {
      const mail = bookingReminder(tenant, booking, duration);
      await attempt('reminder-email', { bookingId: booking.id }, async () => {
        const result = await sendMail({
          tenantId: tenant.id,
          to: { name: booking.customerName, email: booking.customerEmail },
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
          template: 'aminning',
          relatedBookingId: booking.id,
        });
        if (result.status !== 'villa') sent = true;
      });
    }

    if (isFeatureEnabled(tenant.id, 'sms') && canReceiveSms(booking.customerPhone)) {
      await attempt('reminder-sms', { bookingId: booking.id }, async () => {
        const result = await sendSms({
          tenantId: tenant.id,
          to: booking.customerPhone,
          body:
            `${tenant.name}: Áminning um tímann þinn ${formatDateTimeIs(booking.startsAt, tenant.timezone)} — ${booking.serviceName}. ` +
            `Afbóka: ${config.baseUrl}/afbokun/${booking.cancelToken}`,
          template: 'aminning',
          relatedBookingId: booking.id,
        });
        if (result.status !== 'villa') sent = true;
      });
    }

    // Mark it sent either way; a permanently unreachable customer must not be
    // retried on every worker tick.
    void sent;
    markReminderSent(booking.id);
  });

  // -------------------------------------------------------------------------
  // Webstore: an order arrived.
  // -------------------------------------------------------------------------
  on('order.created', async ({ order }) => {
    const tenant = getTenantOrThrow(order.tenantId);
    const summary = order.items
      .map((item) => (item.quantity > 1 ? `${item.name} × ${item.quantity}` : item.name))
      .join(', ');

    await attempt('push', { orderId: order.id }, () =>
      sendPush({
        tenantId: tenant.id,
        kind: 'ny_pontun',
        title: `Ný pöntun · ${formatISK(order.totalIsk)}`,
        body: `${order.customerName}\n${summary}`,
        data: { orderId: order.id, url: `${config.baseUrl}/vidskiptavinir/${tenant.id}/pantanir` },
      }),
    );

    const recipient = tenant.voicemailEmail || tenant.email;
    if (recipient) {
      const mail = newOrderForOwner(tenant, order);
      await attempt('owner-order-email', { orderId: order.id }, () =>
        sendMail({
          tenantId: tenant.id,
          to: recipient,
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
          template: 'ny_pontun_eigandi',
        }),
      );
    }

    if (order.customerEmail) {
      const mail = orderConfirmation(tenant, order, shopSettings(tenant.id).paymentNote);
      await attempt('order-confirmation', { orderId: order.id }, async () => {
        const result = await sendMail({
          tenantId: tenant.id,
          to: { name: order.customerName, email: order.customerEmail },
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
          template: 'pontun_stadfest',
        });
        if (result.status !== 'villa') markOrderConfirmationSent(order.id);
      });
      return;
    }

    // No email address — an SMS with the reference is the only receipt we can
    // give, and the workshop still has the phone number to call back on.
    if (isFeatureEnabled(tenant.id, 'sms') && canReceiveSms(order.customerPhone)) {
      await attempt('order-sms', { orderId: order.id }, async () => {
        const result = await sendSms({
          tenantId: tenant.id,
          to: order.customerPhone,
          body:
            `${tenant.name}: Pöntun ${order.reference} móttekin — ${formatISK(order.totalIsk)}. `
            + `Staða: ${config.baseUrl}/pontun/${order.statusToken}`,
          template: 'pontun_stadfest',
        });
        if (result.status !== 'villa') markOrderConfirmationSent(order.id);
      });
    }
  });

  // -------------------------------------------------------------------------
  // Webstore: the workshop moved an order along.
  // -------------------------------------------------------------------------
  on('order.status', async ({ order, previous }) => {
    if (order.status === previous || !order.customerEmail) return;
    // 'ny' is the state an order is created in, so it never warrants a mail of
    // its own — the confirmation already went out.
    if (order.status === 'ny') return;

    const tenant = getTenantOrThrow(order.tenantId);
    const mail = orderStatusUpdate(tenant, order);

    await attempt('order-status-email', { orderId: order.id, status: order.status }, () =>
      sendMail({
        tenantId: tenant.id,
        to: { name: order.customerName, email: order.customerEmail },
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        template: `pontun_${order.status}`,
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Voicemail transcribed.
  // -------------------------------------------------------------------------
  on('call.finished', async ({ callId, tenantId }) => {
    if (!tenantId) return;
    const tenant = getTenantOrThrow(tenantId);

    const call = get<{ from_number: string; transcript: string; recording_url: string; started_at: number }>(
      'SELECT from_number, transcript, recording_url, started_at FROM call_log WHERE id = ?',
      callId,
    );
    if (!call) return;

    await attempt('voicemail-push', { callId }, () =>
      sendPush({
        tenantId,
        kind: 'skilabod',
        title: 'Ný skilaboð úr símsvara',
        body: `${call.from_number}\n${call.transcript.slice(0, 140) || 'Engin umritun tiltæk'}`,
        data: { callId },
      }),
    );

    const recipient = tenant.voicemailEmail || tenant.email;
    if (recipient) {
      const mail = voicemailNotification(tenant, {
        fromNumber: call.from_number,
        transcript: call.transcript,
        recordingUrl: call.recording_url,
        receivedAt: call.started_at,
      });
      await attempt('voicemail-email', { callId }, () =>
        sendMail({
          tenantId,
          to: recipient,
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
          template: 'skilabod',
        }),
      );
    }
  });

  logger.info('Atburðaviðbrögð skráð');
}

/** Exposed for the dashboard's "next reminder" line. */
export function describeNextReminder(booking: BookingView): string {
  const tenant = getTenantOrThrow(booking.tenantId);
  const remindAt = booking.startsAt - config.booking.reminderHoursBefore * 3_600_000;
  void getServiceOrThrow(booking.serviceId);
  return relativeIs(remindAt, tenant.timezone);
}
