/**
 * Per-request context.
 *
 * The raw body is retained alongside the parsed body because Twilio webhook
 * signatures are computed over the exact bytes received — reserialising a
 * parsed form would produce a different signature and reject valid calls.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import { badRequest } from '../core/errors.ts';
import { parseCookies } from './response.ts';
import type { Method } from './router.ts';

export interface OperatorSession {
  sessionId: string;
  operatorId: string;
  email: string;
  name: string;
  csrfToken: string;
}

export interface RequestContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly method: Method;
  readonly url: URL;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly headers: NodeJS.Dict<string | string[]>;
  readonly ip: string;
  readonly requestId: string;
  readonly startedAt: number;
  readonly rawBody: Buffer;
  readonly cookies: Record<string, string>;

  /** Populated by the router once a route matches. */
  params: Record<string, string>;
  routePath: string;

  /** Populated by `requireOperator` / `loadSession`. */
  session: OperatorSession | null;

  /** Free-form slot for middleware to pass values down the chain. */
  state: Record<string, unknown>;

  /** Parsed request body. Returns `{}` for bodyless requests. */
  body(): Record<string, unknown>;
  /** Body as a flat string map — convenient for HTML form handling. */
  form(): Record<string, string>;
  /** All values for a repeated form field (checkbox groups). */
  formList(field: string): string[];
}

const MAX_BODY_BYTES = 2 * 1024 * 1024;

export async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) {
      throw badRequest('Beiðnin er of stór.');
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function clientIp(req: IncomingMessage): string {
  // Trust the first hop of X-Forwarded-For only; anything further back is
  // attacker-controlled. Deployments behind a proxy set this header.
  const forwarded = req.headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (raw) {
    const first = raw.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'óþekkt';
}

export function createContext(
  req: IncomingMessage,
  res: ServerResponse,
  rawBody: Buffer,
  requestId: string,
  baseUrl: string,
): RequestContext {
  const host = (req.headers.host ?? new URL(baseUrl).host).toString();
  const protocol = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim()
    ?? (baseUrl.startsWith('https') ? 'https' : 'http');
  const url = new URL(req.url ?? '/', `${protocol}://${host}`);

  let parsedBody: Record<string, unknown> | undefined;
  let parsedParams: URLSearchParams | undefined;

  const contentType = (req.headers['content-type'] ?? '').toString().split(';')[0]?.trim().toLowerCase() ?? '';

  const parse = (): Record<string, unknown> => {
    if (parsedBody) return parsedBody;
    if (rawBody.length === 0) {
      parsedBody = {};
      return parsedBody;
    }

    if (contentType === 'application/json') {
      try {
        const value = JSON.parse(rawBody.toString('utf8'));
        parsedBody = value !== null && typeof value === 'object' && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : { value };
      } catch {
        throw badRequest('Ógilt JSON í beiðni.');
      }
      return parsedBody;
    }

    if (contentType === 'application/x-www-form-urlencoded') {
      parsedParams = new URLSearchParams(rawBody.toString('utf8'));
      const out: Record<string, unknown> = {};
      for (const key of new Set(parsedParams.keys())) {
        const values = parsedParams.getAll(key);
        out[key] = values.length > 1 ? values : values[0];
      }
      parsedBody = out;
      return parsedBody;
    }

    parsedBody = { raw: rawBody.toString('utf8') };
    return parsedBody;
  };

  return {
    req,
    res,
    method: (req.method ?? 'GET').toUpperCase() as Method,
    url,
    path: url.pathname,
    query: url.searchParams,
    headers: req.headers,
    ip: clientIp(req),
    requestId,
    startedAt: Date.now(),
    rawBody,
    cookies: parseCookies(req.headers.cookie),
    params: {},
    routePath: '',
    session: null,
    state: {},

    body: parse,

    form(): Record<string, string> {
      const parsed = parse();
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (Array.isArray(value)) out[key] = String(value[value.length - 1] ?? '');
        else if (value !== null && value !== undefined) out[key] = String(value);
      }
      return out;
    },

    formList(field: string): string[] {
      parse();
      if (parsedParams) return parsedParams.getAll(field);
      const value = parsedBody?.[field];
      if (Array.isArray(value)) return value.map(String);
      if (value === undefined || value === null || value === '') return [];
      return [String(value)];
    },
  };
}
