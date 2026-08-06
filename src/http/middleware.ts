/**
 * Shared middleware: session loading, access control, CSRF and CORS.
 */

import { config } from '../config.ts';
import { forbidden, unauthorized } from '../core/errors.ts';
import { resolveSession, SESSION_COOKIE, verifyCsrf } from '../domain/auth.ts';
import type { RequestContext } from './context.ts';
import { redirect, type HttpResponse } from './response.ts';
import type { Middleware } from './router.ts';

/** Attaches the operator session to the context when a valid cookie is present. */
export const loadSession: Middleware = async (ctx, next) => {
  ctx.session = resolveSession(ctx.cookies[SESSION_COOKIE]);
  return next();
};

/**
 * Requires a signed-in operator. Browser requests are redirected to the login
 * page with a `next` parameter; API requests get a 401.
 */
export const requireOperator: Middleware = async (ctx, next) => {
  if (!ctx.session) {
    if (ctx.path.startsWith('/api/')) throw unauthorized();
    const next_ = encodeURIComponent(ctx.url.pathname + ctx.url.search);
    return redirect(`/innskraning?next=${next_}`);
  }
  return next();
};

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF protection for state-changing requests.
 *
 * Two independent checks: a session-bound token, and an Origin/Referer match.
 * SameSite=Lax cookies already block most cross-site POSTs; these cover the
 * cases it does not (older browsers, and same-site subdomain attacks).
 */
export const csrfProtect: Middleware = async (ctx, next) => {
  if (SAFE_METHODS.has(ctx.method)) return next();

  const origin = (ctx.headers.origin ?? '').toString();
  if (origin) {
    const expected = new URL(config.baseUrl).origin;
    if (origin !== expected && origin !== ctx.url.origin) {
      throw forbidden('Beiðnin kom frá óþekktum uppruna.');
    }
  }

  const submitted =
    ctx.form()._csrf ??
    (ctx.headers['x-csrf-token'] as string | undefined) ??
    '';

  if (!verifyCsrf(ctx.session, submitted)) {
    throw forbidden('Öryggisauðkenni vantar eða er útrunnið. Endurhlaðið síðuna og reynið aftur.');
  }
  return next();
};

/**
 * Permissive CORS for the public booking API only — generated tenant websites
 * are served from their own domains and must be able to call it.
 */
export const publicCors: Middleware = async (ctx, next) => {
  const headers: Record<string, string> = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
  };

  if (ctx.method === 'OPTIONS') {
    return { status: 204, headers, body: '' };
  }

  const response = await next();
  return { ...response, headers: { ...response.headers, ...headers } };
};

/** Adds a content security policy to HTML responses. */
export const contentSecurityPolicy: Middleware = async (ctx, next) => {
  const response = await next();
  const contentType = String(response.headers['content-type'] ?? '');
  if (!contentType.startsWith('text/html')) return response;

  // A handler that set its own policy knows something this middleware does not
  // — the website preview, for instance, must be embeddable in the console.
  if (response.headers['content-security-policy']) return response;

  // The admin console and generated sites use inline <style> and small inline
  // scripts, so 'unsafe-inline' is required for style-src and script-src.
  // Everything else is locked to same-origin.
  const policy = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');

  return {
    ...response,
    headers: {
      ...response.headers,
      'content-security-policy': policy,
      ...(config.isProduction ? { 'strict-transport-security': 'max-age=31536000; includeSubDomains' } : {}),
    },
  };
};

/** Simple in-memory sliding-window limiter for unauthenticated endpoints. */
export function rateLimit(options: { windowMs: number; max: number; key?: (ctx: RequestContext) => string }): Middleware {
  const hits = new Map<string, number[]>();

  return async (ctx, next): Promise<HttpResponse> => {
    const key = options.key ? options.key(ctx) : ctx.ip;
    const now = Date.now();
    const cutoff = now - options.windowMs;

    const timestamps = (hits.get(key) ?? []).filter((t) => t > cutoff);
    timestamps.push(now);
    hits.set(key, timestamps);

    // Opportunistic cleanup so the map cannot grow without bound.
    if (hits.size > 5000) {
      for (const [k, v] of hits) {
        if (v.every((t) => t <= cutoff)) hits.delete(k);
      }
    }

    if (timestamps.length > options.max) {
      return {
        status: 429,
        headers: { 'content-type': 'application/json; charset=utf-8', 'retry-after': String(Math.ceil(options.windowMs / 1000)) },
        body: JSON.stringify({ villa: 'of_margar_beidnir', skilabod: 'Of margar beiðnir. Reyndu aftur eftir smástund.' }),
      };
    }

    return next();
  };
}
