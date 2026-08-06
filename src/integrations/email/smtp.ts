/**
 * A minimal but correct SMTP client.
 *
 * Written directly against `node:net`/`node:tls` rather than pulling in a mail
 * library, for the same reason the rest of the platform has no dependencies:
 * this is the component that must still work in three years, and SMTP has not
 * changed since 2008.
 *
 * Supports what actually matters for transactional mail from Iceland:
 *   - implicit TLS (port 465) and STARTTLS upgrade (port 587)
 *   - AUTH PLAIN and AUTH LOGIN
 *   - UTF-8 subjects and bodies (RFC 2047 encoded-words, base64 body)
 *   - multipart/alternative so clients that refuse HTML still show the text
 *
 * Works with Gmail/Google Workspace, Proton Mail Bridge, and any standard host.
 */

import { createConnection, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';

import { IntegrationError } from '../../core/errors.ts';
import { logger } from '../../core/logger.ts';

export interface SmtpConfig {
  host: string;
  port: number;
  user?: string;
  password?: string;
  /** true for port 465; false performs a STARTTLS upgrade. */
  implicitTls: boolean;
  timeoutMs?: number;
  /** Only for self-signed certificates on a private relay. */
  rejectUnauthorized?: boolean;
}

export interface MailAddress {
  name?: string;
  email: string;
}

export interface OutgoingMail {
  from: MailAddress;
  to: MailAddress[];
  replyTo?: MailAddress;
  subject: string;
  text: string;
  html?: string;
  headers?: Record<string, string>;
}

interface SmtpReply {
  code: number;
  lines: string[];
}

/**
 * Wraps a socket with line-oriented reads and SMTP reply parsing.
 * SMTP replies are `NNN-continuation` lines ending with a single `NNN final`.
 */
class SmtpConnection {
  private socket: Socket | TLSSocket;
  private buffer = '';
  private readonly timeoutMs: number;
  private closed = false;

  constructor(socket: Socket | TLSSocket, timeoutMs: number) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.socket.setEncoding('utf8');
    this.socket.setTimeout(timeoutMs);
  }

  replaceSocket(socket: TLSSocket): void {
    this.socket.removeAllListeners('data');
    this.socket = socket;
    this.socket.setEncoding('utf8');
    this.socket.setTimeout(this.timeoutMs);
    this.buffer = '';
  }

  get raw(): Socket | TLSSocket {
    return this.socket;
  }

  async readReply(): Promise<SmtpReply> {
    const deadline = Date.now() + this.timeoutMs;

    for (;;) {
      const complete = this.tryParse();
      if (complete) return complete;

      if (Date.now() > deadline) {
        throw new IntegrationError('smtp', `Tímamörk við lestur svars (${this.timeoutMs}ms)`);
      }

      const [chunk] = (await Promise.race([
        once(this.socket, 'data'),
        once(this.socket, 'timeout').then(() => {
          throw new IntegrationError('smtp', 'Tenging féll á tíma.');
        }),
        once(this.socket, 'close').then(() => {
          throw new IntegrationError('smtp', 'Tengingu lokað af þjóni.');
        }),
      ])) as [string];

      this.buffer += chunk;
    }
  }

  /** Returns a reply once a terminal line ("250 text") has arrived. */
  private tryParse(): SmtpReply | null {
    const lines = this.buffer.split('\r\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // Terminal line: three digits followed by a space.
      if (/^\d{3} /.test(line)) {
        const consumed = lines.slice(0, i + 1);
        this.buffer = lines.slice(i + 1).join('\r\n');
        return {
          code: Number.parseInt(line.slice(0, 3), 10),
          lines: consumed.map((l) => l.slice(4)),
        };
      }
    }
    return null;
  }

  async send(command: string, options: { secret?: boolean } = {}): Promise<SmtpReply> {
    if (!options.secret) logger.debug('SMTP >', { command: command.slice(0, 120) });
    this.socket.write(`${command}\r\n`);
    return this.readReply();
  }

  /** Writes the DATA payload without waiting for a reply. */
  write(payload: string): void {
    this.socket.write(payload);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
  }
}

function expect(reply: SmtpReply, expected: number[], step: string): void {
  if (!expected.includes(reply.code)) {
    throw new IntegrationError('smtp', `${step} mistókst: ${reply.code} ${reply.lines.join(' | ')}`);
  }
}

/**
 * Sends one message and closes the connection.
 *
 * A fresh connection per message is slightly wasteful, but this platform sends
 * a handful of transactional mails an hour, and a long-lived pooled connection
 * would need reconnect handling for no measurable benefit.
 */
export async function sendSmtpMail(smtp: SmtpConfig, mail: OutgoingMail): Promise<{ messageId: string; response: string }> {
  const timeoutMs = smtp.timeoutMs ?? 20_000;
  const rawSocket = smtp.implicitTls
    ? tlsConnect({
        host: smtp.host,
        port: smtp.port,
        servername: smtp.host,
        rejectUnauthorized: smtp.rejectUnauthorized ?? true,
      })
    : createConnection({ host: smtp.host, port: smtp.port });

  const connection = new SmtpConnection(rawSocket, timeoutMs);

  try {
    await Promise.race([
      once(rawSocket, smtp.implicitTls ? 'secureConnect' : 'connect'),
      once(rawSocket, 'error').then(([error]) => {
        throw new IntegrationError('smtp', `Tenging við ${smtp.host}:${smtp.port} mistókst: ${String(error)}`);
      }),
    ]);

    expect(await connection.readReply(), [220], 'Tenging');

    const clientName = 'rafraen-thjonusta';
    let ehlo = await connection.send(`EHLO ${clientName}`);
    if (ehlo.code !== 250) {
      // Very old servers only speak HELO.
      expect(await connection.send(`HELO ${clientName}`), [250], 'HELO');
      ehlo = { code: 250, lines: [] };
    }

    let capabilities = ehlo.lines.join(' ').toUpperCase();

    if (!smtp.implicitTls) {
      if (!capabilities.includes('STARTTLS')) {
        throw new IntegrationError('smtp', `Þjónninn ${smtp.host} býður ekki upp á STARTTLS — neita að senda lykilorð ódulkóðað.`);
      }
      expect(await connection.send('STARTTLS'), [220], 'STARTTLS');

      const secure = tlsConnect({
        socket: connection.raw as Socket,
        servername: smtp.host,
        rejectUnauthorized: smtp.rejectUnauthorized ?? true,
      });
      await Promise.race([
        once(secure, 'secureConnect'),
        once(secure, 'error').then(([error]) => {
          throw new IntegrationError('smtp', `TLS-handaband mistókst: ${String(error)}`);
        }),
      ]);
      connection.replaceSocket(secure);

      // Capabilities must be re-read after the upgrade.
      const secureEhlo = await connection.send(`EHLO ${clientName}`);
      expect(secureEhlo, [250], 'EHLO eftir STARTTLS');
      capabilities = secureEhlo.lines.join(' ').toUpperCase();
    }

    if (smtp.user && smtp.password) {
      await authenticate(connection, capabilities, smtp.user, smtp.password);
    }

    expect(await connection.send(`MAIL FROM:<${mail.from.email}>`), [250], 'MAIL FROM');

    for (const recipient of mail.to) {
      expect(await connection.send(`RCPT TO:<${recipient.email}>`), [250, 251], `RCPT TO ${recipient.email}`);
    }

    expect(await connection.send('DATA'), [354], 'DATA');

    const messageId = `<${randomBytes(16).toString('hex')}@rafraen-thjonusta>`;
    connection.write(buildMessage(mail, messageId));
    const dataReply = await connection.readReply();
    expect(dataReply, [250], 'Sending');

    await connection.send('QUIT').catch(() => undefined);

    return { messageId, response: dataReply.lines.join(' ') };
  } finally {
    connection.close();
  }
}

async function authenticate(connection: SmtpConnection, capabilities: string, user: string, password: string): Promise<void> {
  if (capabilities.includes('AUTH') && capabilities.includes('PLAIN')) {
    const credentials = Buffer.from(`\0${user}\0${password}`, 'utf8').toString('base64');
    const reply = await connection.send(`AUTH PLAIN ${credentials}`, { secret: true });
    expect(reply, [235], 'Auðkenning (PLAIN)');
    return;
  }

  if (capabilities.includes('LOGIN')) {
    expect(await connection.send('AUTH LOGIN'), [334], 'Auðkenning (LOGIN)');
    expect(
      await connection.send(Buffer.from(user, 'utf8').toString('base64'), { secret: true }),
      [334],
      'Auðkenning (notandanafn)',
    );
    expect(
      await connection.send(Buffer.from(password, 'utf8').toString('base64'), { secret: true }),
      [235],
      'Auðkenning (lykilorð)',
    );
    return;
  }

  throw new IntegrationError('smtp', 'Þjónninn styður enga auðkenningaraðferð sem við þekkjum (PLAIN/LOGIN).');
}

// ---------------------------------------------------------------------------
// Message construction
// ---------------------------------------------------------------------------

/**
 * RFC 2047 encoded-word. Required for Icelandic characters in headers —
 * "Staðfesting á tíma" in a raw Subject header is not valid SMTP.
 */
export function encodeHeaderValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function formatAddress(address: MailAddress): string {
  if (!address.name) return address.email;
  return `${encodeHeaderValue(address.name)} <${address.email}>`;
}

/** Base64 with the 76-character line limit RFC 2045 requires. */
function base64Body(content: string): string {
  const encoded = Buffer.from(content, 'utf8').toString('base64');
  return encoded.replace(/(.{76})/g, '$1\r\n');
}

export function buildMessage(mail: OutgoingMail, messageId: string): string {
  const boundary = `----rafraen_${randomBytes(12).toString('hex')}`;
  const date = new Date().toUTCString();

  const headers: string[] = [
    `From: ${formatAddress(mail.from)}`,
    `To: ${mail.to.map(formatAddress).join(', ')}`,
    `Subject: ${encodeHeaderValue(mail.subject)}`,
    `Date: ${date}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
  ];

  if (mail.replyTo) headers.push(`Reply-To: ${formatAddress(mail.replyTo)}`);
  for (const [key, value] of Object.entries(mail.headers ?? {})) {
    headers.push(`${key}: ${encodeHeaderValue(value)}`);
  }

  let body: string;
  if (mail.html) {
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    body = [
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      base64Body(mail.text),
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      base64Body(mail.html),
      '',
      `--${boundary}--`,
    ].join('\r\n');
  } else {
    headers.push('Content-Type: text/plain; charset=UTF-8');
    headers.push('Content-Transfer-Encoding: base64');
    body = `\r\n${base64Body(mail.text)}`;
  }

  const message = `${headers.join('\r\n')}\r\n${body}`;

  // Dot-stuffing: a line consisting of a single "." would end the DATA phase.
  const stuffed = message.replace(/\r\n\./g, '\r\n..');
  return `${stuffed}\r\n.\r\n`;
}
