/**
 * TwiML builder.
 *
 * TwiML is just XML, so this is a small, typed builder rather than a
 * dependency. Everything interpolated is XML-escaped, which matters because
 * spoken text includes customer names and service descriptions.
 *
 * Icelandic speech uses Amazon Polly's `Dóra` voice (`Polly.Dora`), which
 * Twilio exposes for `is-IS`. Without an explicit voice, Twilio falls back to
 * an English speaker reading Icelandic text, which is unusable.
 */

import { escapeXml } from '../../core/html.ts';

export const ICELANDIC_VOICE = 'Polly.Dora';
export const ICELANDIC_LANGUAGE = 'is-IS';

export interface SayOptions {
  voice?: string;
  language?: string;
  /** Repeat the phrase; useful for numbers read back to the caller. */
  loop?: number;
}

export class TwiML {
  private readonly parts: string[] = [];

  say(text: string, options: SayOptions = {}): this {
    const attrs = [
      `voice="${escapeXml(options.voice ?? ICELANDIC_VOICE)}"`,
      `language="${escapeXml(options.language ?? ICELANDIC_LANGUAGE)}"`,
      options.loop ? `loop="${options.loop}"` : '',
    ].filter(Boolean).join(' ');
    this.parts.push(`<Say ${attrs}>${escapeXml(text)}</Say>`);
    return this;
  }

  pause(seconds: number): this {
    this.parts.push(`<Pause length="${Math.max(1, Math.round(seconds))}"/>`);
    return this;
  }

  /**
   * Collects DTMF and/or speech.
   *
   * `speechTimeout="auto"` lets Twilio detect the end of an utterance rather
   * than waiting a fixed period, which makes the receptionist feel responsive
   * instead of stilted.
   */
  gather(
    options: {
      action: string;
      numDigits?: number;
      timeout?: number;
      input?: 'dtmf' | 'speech' | 'dtmf speech';
      language?: string;
      hints?: string;
      speechTimeout?: string;
      finishOnKey?: string;
    },
    build: (nested: TwiML) => void,
  ): this {
    const nested = new TwiML();
    build(nested);

    const attrs = [
      `action="${escapeXml(options.action)}"`,
      'method="POST"',
      `input="${escapeXml(options.input ?? 'dtmf speech')}"`,
      `language="${escapeXml(options.language ?? ICELANDIC_LANGUAGE)}"`,
      options.numDigits ? `numDigits="${options.numDigits}"` : '',
      `timeout="${options.timeout ?? 6}"`,
      options.speechTimeout ? `speechTimeout="${escapeXml(options.speechTimeout)}"` : 'speechTimeout="auto"',
      options.hints ? `hints="${escapeXml(options.hints)}"` : '',
      options.finishOnKey ? `finishOnKey="${escapeXml(options.finishOnKey)}"` : '',
    ].filter(Boolean).join(' ');

    this.parts.push(`<Gather ${attrs}>${nested.inner()}</Gather>`);
    return this;
  }

  /** Forwards to a human. `callerId` keeps the business's number on display. */
  dial(number: string, options: { callerId?: string; timeout?: number; action?: string } = {}): this {
    const attrs = [
      options.callerId ? `callerId="${escapeXml(options.callerId)}"` : '',
      `timeout="${options.timeout ?? 25}"`,
      options.action ? `action="${escapeXml(options.action)}" method="POST"` : '',
    ].filter(Boolean).join(' ');
    this.parts.push(`<Dial ${attrs}><Number>${escapeXml(number)}</Number></Dial>`);
    return this;
  }

  record(options: {
    action: string;
    maxLength?: number;
    transcribe?: boolean;
    transcribeCallback?: string;
    playBeep?: boolean;
  }): this {
    const attrs = [
      `action="${escapeXml(options.action)}"`,
      'method="POST"',
      `maxLength="${options.maxLength ?? 120}"`,
      `playBeep="${options.playBeep === false ? 'false' : 'true'}"`,
      options.transcribe ? 'transcribe="true"' : '',
      options.transcribeCallback ? `transcribeCallback="${escapeXml(options.transcribeCallback)}"` : '',
      'finishOnKey="#"',
    ].filter(Boolean).join(' ');
    this.parts.push(`<Record ${attrs}/>`);
    return this;
  }

  redirect(url: string): this {
    this.parts.push(`<Redirect method="POST">${escapeXml(url)}</Redirect>`);
    return this;
  }

  hangup(): this {
    this.parts.push('<Hangup/>');
    return this;
  }

  /** Sends an SMS from within the call flow. */
  message(body: string, options: { to?: string; from?: string } = {}): this {
    const attrs = [
      options.to ? `to="${escapeXml(options.to)}"` : '',
      options.from ? `from="${escapeXml(options.from)}"` : '',
    ].filter(Boolean).join(' ');
    this.parts.push(`<Message ${attrs}>${escapeXml(body)}</Message>`);
    return this;
  }

  private inner(): string {
    return this.parts.join('');
  }

  toString(): string {
    return `<?xml version="1.0" encoding="UTF-8"?><Response>${this.inner()}</Response>`;
  }
}

export function twiml(build: (response: TwiML) => void): string {
  const response = new TwiML();
  build(response);
  return response.toString();
}
