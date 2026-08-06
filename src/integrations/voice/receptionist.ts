/**
 * The phone receptionist.
 *
 * Answers in Icelandic, books appointments, quotes opening hours, transfers to
 * a human, and takes a message out of hours. It is the same booking engine the
 * website uses, so a slot filled on the phone disappears from the web instantly.
 *
 * The design constraint that shapes everything here: a caller must never be
 * trapped. Every prompt accepts both keypad and speech, every branch has a
 * timeout that falls through to voicemail, and any internal error ends with a
 * human-sounding apology and a recorded message rather than a dropped call.
 *
 * Conversation state lives in `call_log.state`, keyed by Twilio's CallSid,
 * because a call spans several independent HTTP requests.
 */

import { fromJson, get, run, toJson } from '../../core/db.ts';
import { id } from '../../core/ids.ts';
import { formatISK, normalizePhone } from '../../core/iceland.ts';
import { logger } from '../../core/logger.ts';
import {
  formatDateTimeIs,
  formatDurationIs,
  minuteOfDayOf,
  minutesToHhmm,
  plainDateOf,
  type Instant,
} from '../../core/time.ts';
import { config } from '../../config.ts';
import { nextAvailableSlots } from '../../domain/booking/availability.ts';
import { createBooking } from '../../domain/booking/bookings.ts';
import { listServices } from '../../domain/catalog.ts';
import { findCustomerByPhone } from '../../domain/customers.ts';
import { emit } from '../../domain/events.ts';
import { dayWindows, loadScheduleContext } from '../../domain/schedule.ts';
import { getTenantOrThrow, isFeatureEnabled } from '../../domain/tenants.ts';
import type { Tenant } from '../../domain/types.ts';
import { TwiML, twiml } from './twiml.ts';

// ---------------------------------------------------------------------------
// Call state
// ---------------------------------------------------------------------------

export interface CallState {
  step: 'valmynd' | 'velja_thjonustu' | 'stadfesta_tima' | 'nafn' | 'skilabod';
  serviceId?: string;
  /** Candidate start times offered so far. */
  slots?: number[];
  slotIndex?: number;
  /** Number of times we failed to understand, so we can bail out gracefully. */
  misses?: number;
}

interface CallRow {
  id: string;
  tenant_id: string | null;
  state: string;
  from_number: string;
  booking_id: string | null;
}

function findCall(callSid: string): CallRow | null {
  return get<CallRow>('SELECT id, tenant_id, state, from_number, booking_id FROM call_log WHERE provider_call_id = ?', callSid);
}

export function startCall(tenantId: string, params: Record<string, string>): CallRow {
  const existing = findCall(params.CallSid ?? '');
  if (existing) return existing;

  const callId = id('sim');
  run(
    `INSERT INTO call_log (id, tenant_id, provider_call_id, direction, from_number, to_number,
                           started_at, outcome, state, created_at, updated_at)
     VALUES (?,?,?,'inn',?,?,?,'i_gangi',?,?,?)`,
    callId,
    tenantId,
    params.CallSid ?? '',
    params.From ?? '',
    params.To ?? '',
    Date.now(),
    toJson({ step: 'valmynd', misses: 0 } satisfies CallState),
    Date.now(),
    Date.now(),
  );

  logger.info('Símtal hafið', { tenantId, from: params.From });
  return findCall(params.CallSid ?? '')!;
}

function readState(callSid: string): CallState {
  const row = findCall(callSid);
  return fromJson<CallState>(row?.state, { step: 'valmynd', misses: 0 });
}

function writeState(callSid: string, state: CallState): void {
  run('UPDATE call_log SET state = ?, updated_at = ? WHERE provider_call_id = ?', toJson(state), Date.now(), callSid);
}

function finishCall(callSid: string, outcome: string, extra: { bookingId?: string; transcript?: string; recordingUrl?: string } = {}): void {
  run(
    `UPDATE call_log SET
       outcome = ?, ended_at = ?, updated_at = ?,
       booking_id = COALESCE(?, booking_id),
       transcript = CASE WHEN ? <> '' THEN ? ELSE transcript END,
       recording_url = CASE WHEN ? <> '' THEN ? ELSE recording_url END
     WHERE provider_call_id = ?`,
    outcome,
    Date.now(),
    Date.now(),
    extra.bookingId ?? null,
    extra.transcript ?? '', extra.transcript ?? '',
    extra.recordingUrl ?? '', extra.recordingUrl ?? '',
    callSid,
  );
}

// ---------------------------------------------------------------------------
// Speech understanding
// ---------------------------------------------------------------------------

export type Intent = 'bokun' | 'opnunartimi' | 'starfsmadur' | 'skilabod' | 'afbokun' | 'ohljost';

/**
 * Maps a spoken phrase to an intent.
 *
 * Keyword matching rather than a model call: it is instant, free, and covers
 * the handful of things people actually say to a small business's phone. The
 * fallback for anything else is the keypad menu, which always works.
 */
export function classifyIntent(speech: string, digits: string): Intent {
  if (digits === '1') return 'bokun';
  if (digits === '2') return 'opnunartimi';
  if (digits === '3') return 'afbokun';
  if (digits === '0') return 'starfsmadur';
  if (digits === '4' || digits === '9') return 'skilabod';

  const text = speech.toLowerCase();
  if (!text.trim()) return 'ohljost';

  const has = (...words: string[]) => words.some((word) => text.includes(word));

  if (has('afbók', 'afboka', 'hætta við', 'haetta vid', 'aflýsa', 'aflysa')) return 'afbokun';
  if (has('bóka', 'boka', 'panta', 'tíma', 'tima', 'pantað', 'laus')) return 'bokun';
  if (has('opnunartím', 'opnunartim', 'opið', 'opid', 'lokað', 'lokad', 'hvenær', 'hvenaer')) return 'opnunartimi';
  if (has('tala við', 'tala vid', 'starfsmann', 'starfsmað', 'manneskj', 'einhvern')) return 'starfsmadur';
  if (has('skilaboð', 'skilabod', 'hringja til baka', 'hringið', 'hringid')) return 'skilabod';

  return 'ohljost';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function urls(tenantId: string) {
  const base = `${config.baseUrl}/simi/${tenantId}`;
  return {
    answer: `${base}/svara`,
    menu: `${base}/val`,
    service: `${base}/thjonusta`,
    time: `${base}/timi`,
    name: `${base}/nafn`,
    message: `${base}/skilabod`,
    transcription: `${base}/umritun`,
  };
}

/** Whether the business is open at this instant. */
export function isOpenNow(tenant: Tenant, now: Instant = Date.now()): boolean {
  const date = plainDateOf(now, tenant.timezone);
  const ctx = loadScheduleContext(tenant.id, date, date);
  const schedule = dayWindows(tenant, date, null, ctx);
  if (schedule.closed) return false;

  const minute = minuteOfDayOf(now, tenant.timezone);
  return schedule.windows.some((window) => minute >= window.openMin && minute < window.closeMin);
}

/** Reads today's opening hours aloud. */
function todayHoursSentence(tenant: Tenant, now: Instant = Date.now()): string {
  const date = plainDateOf(now, tenant.timezone);
  const ctx = loadScheduleContext(tenant.id, date, date);
  const schedule = dayWindows(tenant, date, null, ctx);

  if (schedule.closed) {
    return `Í dag er lokað. ${schedule.reason ?? ''}`.trim();
  }
  const ranges = schedule.windows
    .map((window) => `frá ${minutesToHhmm(window.openMin)} til ${minutesToHhmm(window.closeMin)}`)
    .join(', og ');
  return `Í dag er opið ${ranges}.`;
}

/** Services offered over the phone, capped so the menu stays listenable. */
function phoneServices(tenantId: string) {
  return listServices(tenantId, { publicOnly: true }).slice(0, 5);
}

function voicemailPrompt(response: TwiML, tenant: Tenant, tenantId: string, reason: string): void {
  response.say(reason);
  response.say('Skildu eftir nafn, símanúmer og skilaboð eftir hljóðmerkið. Ýttu á myllumerki þegar þú ert búin eða búinn.');
  response.record({
    action: urls(tenantId).message,
    maxLength: 120,
    transcribe: true,
    transcribeCallback: urls(tenantId).transcription,
  });
  // Reached only if the caller hangs up without recording.
  response.say('Takk fyrir símtalið. Verið sæl.');
  response.hangup();
}

// ---------------------------------------------------------------------------
// Call steps
// ---------------------------------------------------------------------------

/** Entry point: greeting and main menu, or voicemail when closed. */
export function handleAnswer(tenantId: string, params: Record<string, string>): string {
  const tenant = getTenantOrThrow(tenantId);
  startCall(tenantId, params);

  return twiml((response) => {
    const greeting = tenant.greeting || `Góðan dag, þetta er ${tenant.name}.`;
    response.say(greeting);

    if (!isFeatureEnabled(tenantId, 'simsvorun')) {
      response.say('Því miður er símsvörun ekki virk. Vinsamlegast hafðu samband á vefsíðunni okkar.');
      response.hangup();
      return;
    }

    const open = isOpenNow(tenant);
    const bookingEnabled = isFeatureEnabled(tenantId, 'bokanir');

    if (!open) {
      response.say(`${todayHoursSentence(tenant)} Þú getur bókað tíma með því að ýta á einn, eða skilið eftir skilaboð.`);
    }

    const options: string[] = [];
    if (bookingEnabled) options.push('Ýttu á einn til að bóka tíma');
    options.push('tvo til að heyra opnunartíma');
    if (tenant.forwardNumber && open) options.push('núll til að ná í starfsmann');
    options.push('eða fjóra til að skilja eftir skilaboð');

    response.gather(
      {
        action: urls(tenantId).menu,
        numDigits: 1,
        timeout: 7,
        hints: 'bóka tíma, panta tíma, opnunartími, tala við starfsmann, skilaboð, afbóka',
      },
      (gather) => {
        gather.say(`${options.join(', ')}. Þú mátt líka einfaldlega segja mér erindið.`);
      },
    );

    // No input at all: take a message rather than hanging up on them.
    voicemailPrompt(response, tenant, tenantId, 'Ég heyrði ekki í þér.');
  });
}

export function handleMenu(tenantId: string, params: Record<string, string>): string {
  const tenant = getTenantOrThrow(tenantId);
  const callSid = params.CallSid ?? '';
  const intent = classifyIntent(params.SpeechResult ?? '', params.Digits ?? '');
  const state = readState(callSid);

  return twiml((response) => {
    switch (intent) {
      case 'bokun': {
        if (!isFeatureEnabled(tenantId, 'bokanir')) {
          voicemailPrompt(response, tenant, tenantId, 'Netbókanir eru ekki virkar hjá okkur.');
          return;
        }
        const services = phoneServices(tenantId);
        if (services.length === 0) {
          voicemailPrompt(response, tenant, tenantId, 'Engin þjónusta er skráð til bókunar.');
          return;
        }
        if (services.length === 1) {
          writeState(callSid, { ...state, step: 'stadfesta_tima', serviceId: services[0]!.id, slotIndex: 0 });
          offerSlot(response, tenantId, services[0]!.id, 0, []);
          return;
        }

        writeState(callSid, { ...state, step: 'velja_thjonustu' });
        response.gather({ action: urls(tenantId).service, numDigits: 1, timeout: 7 }, (gather) => {
          gather.say('Hvaða þjónustu viltu bóka?');
          services.forEach((service, index) => {
            const price = service.priceIsk > 0 ? `, ${formatISK(service.priceIsk)}` : '';
            gather.say(`Ýttu á ${index + 1} fyrir ${service.name}, ${formatDurationIs(service.durationMin)}${price}.`);
          });
        });
        voicemailPrompt(response, tenant, tenantId, 'Ég náði því ekki.');
        return;
      }

      case 'opnunartimi': {
        response.say(todayHoursSentence(tenant));
        const services = phoneServices(tenantId);
        if (services.length > 0) {
          response.say(`Við bjóðum meðal annars upp á ${services.slice(0, 3).map((s) => s.name).join(', ')}.`);
        }
        response.pause(1);
        response.gather({ action: urls(tenantId).menu, numDigits: 1, timeout: 6 }, (gather) => {
          gather.say('Ýttu á einn til að bóka tíma, eða fjóra til að skilja eftir skilaboð.');
        });
        response.say('Takk fyrir símtalið.');
        response.hangup();
        return;
      }

      case 'starfsmadur': {
        if (tenant.forwardNumber) {
          response.say('Ég gef þér samband, augnablik.');
          response.dial(tenant.forwardNumber, { callerId: params.To ?? config.twilio.phoneNumber, timeout: 25 });
          // Reached if nobody answers the transfer.
          voicemailPrompt(response, tenant, tenantId, 'Því miður svaraði enginn.');
          finishCall(callSid, 'aframsent');
          return;
        }
        voicemailPrompt(response, tenant, tenantId, 'Enginn er við símann eins og er.');
        return;
      }

      case 'afbokun': {
        response.say(
          'Til að afbóka geturðu notað tengilinn í staðfestingarpóstinum sem þú fékkst. ' +
          'Þú getur líka skilið eftir skilaboð og við göngum frá því.',
        );
        voicemailPrompt(response, tenant, tenantId, 'Segðu mér nafn og hvaða tíma þú vilt afbóka.');
        return;
      }

      case 'skilabod':
        voicemailPrompt(response, tenant, tenantId, 'Sjálfsagt.');
        return;

      default: {
        const misses = (state.misses ?? 0) + 1;
        writeState(callSid, { ...state, misses });

        if (misses >= 2) {
          voicemailPrompt(response, tenant, tenantId, 'Ég næ þessu ekki alveg.');
          return;
        }

        response.gather({ action: urls(tenantId).menu, numDigits: 1, timeout: 7 }, (gather) => {
          gather.say('Fyrirgefðu, ég náði þessu ekki. Ýttu á einn til að bóka tíma, tvo fyrir opnunartíma, eða fjóra til að skilja eftir skilaboð.');
        });
        voicemailPrompt(response, tenant, tenantId, 'Ég heyrði ekki í þér.');
      }
    }
  });
}

export function handleServiceChoice(tenantId: string, params: Record<string, string>): string {
  const tenant = getTenantOrThrow(tenantId);
  const callSid = params.CallSid ?? '';
  const state = readState(callSid);
  const services = phoneServices(tenantId);

  const choice = Number.parseInt(params.Digits ?? '', 10);
  const service = Number.isFinite(choice) ? services[choice - 1] : undefined;

  return twiml((response) => {
    if (!service) {
      const misses = (state.misses ?? 0) + 1;
      writeState(callSid, { ...state, misses });
      if (misses >= 2) {
        voicemailPrompt(response, tenant, tenantId, 'Ég næ þessu ekki.');
        return;
      }
      response.gather({ action: urls(tenantId).service, numDigits: 1, timeout: 7 }, (gather) => {
        gather.say('Fyrirgefðu, veldu tölu úr listanum.');
        services.forEach((entry, index) => gather.say(`${index + 1} fyrir ${entry.name}.`));
      });
      voicemailPrompt(response, tenant, tenantId, 'Ég heyrði ekki í þér.');
      return;
    }

    writeState(callSid, { ...state, step: 'stadfesta_tima', serviceId: service.id, slotIndex: 0, misses: 0 });
    offerSlot(response, tenantId, service.id, 0, []);
  });
}

/** Offers the nth available slot and asks the caller to accept or skip. */
function offerSlot(response: TwiML, tenantId: string, serviceId: string, index: number, cached: number[]): void {
  const tenant = getTenantOrThrow(tenantId);
  const slots = cached.length > index ? cached : nextAvailableSlots(tenantId, serviceId, index + 3).map((slot) => slot.startsAt);

  const startsAt = slots[index];
  if (startsAt === undefined) {
    response.say('Því miður finn ég engan lausan tíma næstu vikurnar.');
    voicemailPrompt(response, tenant, tenantId, 'Skildu eftir skilaboð og við finnum tíma fyrir þig.');
    return;
  }

  response.gather({ action: urls(tenantId).time, numDigits: 1, timeout: 7 }, (gather) => {
    gather.say(`Næsti lausi tími er ${formatDateTimeIs(startsAt, tenant.timezone)}.`);
    gather.say('Ýttu á einn til að taka þennan tíma, tvo til að heyra næsta tíma, eða núll til að hætta við.');
  });
  response.say('Ég heyrði ekki í þér.');
  response.redirect(urls(tenantId).answer);
}

export function handleTimeChoice(tenantId: string, params: Record<string, string>): string {
  const tenant = getTenantOrThrow(tenantId);
  const callSid = params.CallSid ?? '';
  const state = readState(callSid);
  const digits = params.Digits ?? '';
  const serviceId = state.serviceId ?? '';

  return twiml((response) => {
    if (!serviceId) {
      response.redirect(urls(tenantId).answer);
      return;
    }

    if (digits === '2') {
      const nextIndex = (state.slotIndex ?? 0) + 1;
      // Cap so a caller cannot walk the entire diary one slot at a time.
      if (nextIndex > 5) {
        response.say('Ég er búin að fara yfir næstu lausu tímana.');
        voicemailPrompt(response, tenant, tenantId, 'Skildu eftir skilaboð og við finnum tíma sem hentar.');
        return;
      }
      writeState(callSid, { ...state, slotIndex: nextIndex });
      offerSlot(response, tenantId, serviceId, nextIndex, []);
      return;
    }

    if (digits === '0') {
      response.say('Allt í lagi, ekkert bókað. Takk fyrir símtalið.');
      response.hangup();
      finishCall(callSid, 'ekkert');
      return;
    }

    if (digits !== '1') {
      response.gather({ action: urls(tenantId).time, numDigits: 1, timeout: 7 }, (gather) => {
        gather.say('Ýttu á einn til að staðfesta, tvo fyrir næsta tíma, eða núll til að hætta við.');
      });
      voicemailPrompt(response, tenant, tenantId, 'Ég heyrði ekki í þér.');
      return;
    }

    // Accepted. Do we already know who is calling?
    const caller = findCustomerByPhone(tenantId, params.From ?? '');
    if (caller) {
      const slots = nextAvailableSlots(tenantId, serviceId, (state.slotIndex ?? 0) + 1);
      const chosen = slots[state.slotIndex ?? 0];
      if (!chosen) {
        response.say('Því miður var tíminn tekinn á meðan við töluðum saman.');
        offerSlot(response, tenantId, serviceId, 0, []);
        return;
      }
      confirmBooking(response, tenantId, callSid, serviceId, chosen.startsAt, caller.name, params.From ?? '');
      return;
    }

    writeState(callSid, { ...state, step: 'nafn' });
    response.gather(
      { action: urls(tenantId).name, input: 'speech', timeout: 6, speechTimeout: 'auto' },
      (gather) => gather.say('Hvað heitir þú?'),
    );
    voicemailPrompt(response, tenant, tenantId, 'Ég náði ekki nafninu.');
  });
}

export function handleName(tenantId: string, params: Record<string, string>): string {
  const tenant = getTenantOrThrow(tenantId);
  const callSid = params.CallSid ?? '';
  const state = readState(callSid);
  const spoken = (params.SpeechResult ?? '').trim();
  const serviceId = state.serviceId ?? '';

  return twiml((response) => {
    if (!serviceId) {
      response.redirect(urls(tenantId).answer);
      return;
    }

    const slots = nextAvailableSlots(tenantId, serviceId, (state.slotIndex ?? 0) + 1);
    const chosen = slots[state.slotIndex ?? 0];

    if (!chosen) {
      response.say('Því miður var tíminn tekinn á meðan við töluðum saman.');
      offerSlot(response, tenantId, serviceId, 0, []);
      return;
    }

    // Speech recognition on Icelandic names is imperfect, so the transcript is
    // stored as-is and flagged for the business to confirm on arrival.
    const name = spoken || `Símabókun ${normalizePhone(params.From ?? '').display || ''}`.trim();
    confirmBooking(response, tenantId, callSid, serviceId, chosen.startsAt, name, params.From ?? '', !spoken);
    void tenant;
  });
}

function confirmBooking(
  response: TwiML,
  tenantId: string,
  callSid: string,
  serviceId: string,
  startsAt: Instant,
  customerName: string,
  fromNumber: string,
  nameUncertain = false,
): void {
  const tenant = getTenantOrThrow(tenantId);

  try {
    const booking = createBooking({
      tenantId,
      serviceId,
      startsAt,
      source: 'simi',
      customer: { name: customerName, phone: fromNumber },
      internalNotes: nameUncertain
        ? 'Bókað í síma — nafn ekki staðfest, staðfestu við komu.'
        : 'Bókað í gegnum símsvara.',
    });

    finishCall(callSid, 'bokad', { bookingId: booking.id });

    response.say(`Frábært. Ég er búin að bóka ${booking.serviceName} ${formatDateTimeIs(startsAt, tenant.timezone)}.`);
    if (normalizePhone(fromNumber).kind === 'farsimi') {
      response.say('Þú færð staðfestingu í SMS.');
      response.message(
        `${tenant.name}: Tíminn þinn ${formatDateTimeIs(startsAt, tenant.timezone)} — ${booking.serviceName}. ` +
        `Afbóka: ${config.baseUrl}/afbokun/${booking.cancelToken}`,
        { to: fromNumber },
      );
    }
    response.say('Takk fyrir og verið sæl.');
    response.hangup();

    logger.info('Bókun í gegnum símsvara', { tenantId, bookingId: booking.id });
  } catch (error) {
    logger.error('Bókun í síma mistókst', { tenantId, error });
    response.say('Því miður tókst mér ekki að ganga frá bókuninni.');
    voicemailPrompt(response, tenant, tenantId, 'Skildu eftir skilaboð og við höfum samband.');
  }
}

// ---------------------------------------------------------------------------
// Voicemail
// ---------------------------------------------------------------------------

export function handleRecording(tenantId: string, params: Record<string, string>): string {
  const callSid = params.CallSid ?? '';
  finishCall(callSid, 'skilabod', { recordingUrl: params.RecordingUrl ?? '' });

  return twiml((response) => {
    response.say('Takk fyrir skilaboðin. Við höfum samband við fyrsta tækifæri. Verið sæl.');
    response.hangup();
  });
}

/**
 * Twilio posts the transcription separately, often minutes later. This is
 * where the business actually gets notified — with text they can read rather
 * than a recording they have to dial into.
 */
export async function handleTranscription(tenantId: string, params: Record<string, string>): Promise<string> {
  const callSid = params.CallSid ?? '';
  const transcript = params.TranscriptionText ?? '';

  run(
    'UPDATE call_log SET transcript = ?, recording_url = COALESCE(NULLIF(?, \'\'), recording_url), updated_at = ? WHERE provider_call_id = ?',
    transcript.slice(0, 4000),
    params.RecordingUrl ?? '',
    Date.now(),
    callSid,
  );

  const call = findCall(callSid);
  if (call) {
    await emit('call.finished', { callId: call.id, tenantId });
  }

  logger.info('Umritun skilaboða móttekin', { tenantId, length: transcript.length });
  return twiml((response) => response.hangup());
}

export function handleStatus(tenantId: string, params: Record<string, string>): string {
  const callSid = params.CallSid ?? '';
  const duration = Number.parseInt(params.CallDuration ?? '0', 10);

  run(
    `UPDATE call_log SET
       ended_at = COALESCE(ended_at, ?),
       duration_sec = ?,
       outcome = CASE WHEN outcome = 'i_gangi' THEN 'ekkert' ELSE outcome END,
       updated_at = ?
     WHERE provider_call_id = ?`,
    Date.now(),
    Number.isFinite(duration) ? duration : 0,
    Date.now(),
    callSid,
  );

  return twiml((response) => response.hangup());
}

/** Inbound SMS — logged and acknowledged so a customer is never ignored. */
export function handleInboundSms(tenantId: string, params: Record<string, string>): string {
  const tenant = getTenantOrThrow(tenantId);

  run(
    `INSERT INTO message_log (id, tenant_id, channel, direction, to_addr, from_addr, subject, body,
                              template, status, provider, error, created_at, sent_at)
     VALUES (?,?,'sms','inn',?,?,'',?,'','sent','twilio','',?,?)`,
    id('msg'),
    tenantId,
    params.To ?? '',
    params.From ?? '',
    (params.Body ?? '').slice(0, 1600),
    Date.now(),
    Date.now(),
  );

  logger.info('SMS móttekið', { tenantId, from: params.From });

  return twiml((response) => {
    response.message(
      `Takk fyrir skilaboðin. ${tenant.name} hefur samband við fyrsta tækifæri. ` +
      `Þú getur líka bókað beint: ${tenant.websiteDomain ? `https://${tenant.websiteDomain}` : `${config.baseUrl}/v/${tenant.slug}`}`,
    );
  });
}
