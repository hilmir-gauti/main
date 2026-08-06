/**
 * HTTP response construction.
 *
 * Handlers return a plain `HttpResponse` object rather than writing to the
 * socket. That keeps them synchronous-looking, trivially testable, and lets
 * middleware inspect or replace a response after the fact.
 */

import { SafeHtml } from '../core/html.ts';

export interface HttpResponse {
  status: number;
  headers: Record<string, string | string[]>;
  body: string | Buffer;
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): HttpResponse {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
    body: JSON.stringify(data),
  };
}

export function htmlResponse(body: string | SafeHtml, status = 200, headers: Record<string, string> = {}): HttpResponse {
  return {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
    body: body instanceof SafeHtml ? body.value : body,
  };
}

export function text(body: string, status = 200, headers: Record<string, string> = {}): HttpResponse {
  return {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', ...headers },
    body,
  };
}

/** TwiML and sitemaps. */
export function xml(body: string, status = 200, headers: Record<string, string> = {}): HttpResponse {
  return {
    status,
    headers: { 'content-type': 'application/xml; charset=utf-8', ...headers },
    body,
  };
}

export function redirect(location: string, status: 302 | 303 | 301 | 307 = 303): HttpResponse {
  return { status, headers: { location }, body: '' };
}

export function noContent(): HttpResponse {
  return { status: 204, headers: {}, body: '' };
}

export function file(body: Buffer, contentType: string, headers: Record<string, string> = {}): HttpResponse {
  return {
    status: 200,
    headers: { 'content-type': contentType, ...headers },
    body,
  };
}

/** Appends a Set-Cookie header without clobbering existing ones. */
export function withCookie(response: HttpResponse, cookie: string): HttpResponse {
  const existing = response.headers['set-cookie'];
  const list = existing === undefined ? [] : Array.isArray(existing) ? existing : [existing];
  return { ...response, headers: { ...response.headers, 'set-cookie': [...list, cookie] } };
}

export interface CookieOptions {
  maxAgeSec?: number;
  expires?: Date;
  path?: string;
  domain?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path ?? '/'}`);
  if (options.maxAgeSec !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAgeSec)}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (options.domain) parts.push(`Domain=${options.domain}`);
  if (options.httpOnly !== false) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  parts.push(`SameSite=${options.sameSite ?? 'Lax'}`);
  return parts.join('; ');
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq < 1) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}
