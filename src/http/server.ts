/**
 * HTTP server: request lifecycle, error translation and graceful shutdown.
 */

import { createServer, type Server } from 'node:http';

import { config } from '../config.ts';
import { toAppError } from '../core/errors.ts';
import { token } from '../core/ids.ts';
import { logger } from '../core/logger.ts';
import { createContext, readBody, type RequestContext } from './context.ts';
import { json, text, type HttpResponse } from './response.ts';
import type { Router } from './router.ts';

/** Paths that answer with JSON rather than an HTML error page. */
function wantsJson(ctx: RequestContext): boolean {
  if (ctx.path.startsWith('/api/')) return true;
  const accept = (ctx.headers.accept ?? '').toString();
  return accept.includes('application/json') && !accept.includes('text/html');
}

function errorResponse(ctx: RequestContext, error: unknown): HttpResponse {
  const appError = toAppError(error);

  const level = appError.status >= 500 ? 'error' : 'warn';
  logger[level]('Beiðni mistókst', {
    requestId: ctx.requestId,
    method: ctx.method,
    path: ctx.path,
    status: appError.status,
    code: appError.code,
    // The public message is safe; the internal one may contain detail.
    message: appError.message,
    ...(appError.status >= 500 ? { stack: appError.stack } : {}),
  });

  if (wantsJson(ctx)) {
    return json(
      {
        villa: appError.code,
        skilabod: appError.publicMessage,
        ...(appError.details ? { atridi: appError.details } : {}),
      },
      appError.status,
    );
  }

  return {
    status: appError.status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body: errorPage(appError.status, appError.publicMessage),
  };
}

function errorPage(status: number, message: string): string {
  return `<!doctype html>
<html lang="is"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${status} — Rafræn Þjónusta</title>
<style>
:root{color-scheme:light dark}
body{font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#0b1020;color:#e8ecf7}
.card{max-width:32rem;padding:2.5rem;text-align:center}
h1{font-size:3.5rem;margin:0;color:#6ea8fe}
p{color:#aab4cf}
a{color:#6ea8fe}
</style></head>
<body><div class="card"><h1>${status}</h1><p>${message.replace(/[<>&]/g, '')}</p>
<p><a href="/stjornbord">Aftur á stjórnborð</a></p></div></body></html>`;
}

function notFound(ctx: RequestContext): HttpResponse {
  if (wantsJson(ctx)) return json({ villa: 'fannst_ekki', skilabod: 'Slóðin fannst ekki.' }, 404);
  return { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' }, body: errorPage(404, 'Síðan fannst ekki.') };
}

export function createHttpServer(router: Router): Server {
  const server = createServer((req, res) => {
    const requestId = token(8);

    void (async () => {
      let ctx: RequestContext | null = null;
      try {
        const rawBody = req.method === 'GET' || req.method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
        ctx = createContext(req, res, rawBody, requestId, config.baseUrl);

        const response = await router.handle(ctx, notFound);
        send(ctx, response);
      } catch (error) {
        if (!ctx) {
          // Body read failed before a context existed (oversized or aborted).
          res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('Ógild beiðni.');
          return;
        }
        send(ctx, errorResponse(ctx, error));
      }
    })();
  });

  // Slow-loris protection: a client gets 20s to send headers and body.
  server.headersTimeout = 20_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 65_000;

  return server;
}

function send(ctx: RequestContext, response: HttpResponse): void {
  const { res } = ctx;
  if (res.writableEnded) return;

  const headers: Record<string, string | string[]> = {
    // Applied here so every response — including errors — carries them.
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'x-request-id': ctx.requestId,
    ...response.headers,
  };

  const body = ctx.method === 'HEAD' ? '' : response.body;
  const length = typeof body === 'string' ? Buffer.byteLength(body) : body.length;
  headers['content-length'] = String(length);

  res.writeHead(response.status, headers);
  res.end(body);

  const durationMs = Date.now() - ctx.startedAt;
  const level = response.status >= 500 ? 'error' : response.status >= 400 ? 'warn' : 'info';
  logger[level]('beiðni', {
    requestId: ctx.requestId,
    method: ctx.method,
    path: ctx.path,
    status: response.status,
    ms: durationMs,
    ip: ctx.ip,
  });
}

export function startServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.removeListener('error', reject);
      logger.info('Vefþjónn ræstur', { url: config.baseUrl, port: config.port, umhverfi: config.env });
      resolve();
    });
  });
}

/** Stops accepting connections and waits for in-flight requests to finish. */
export function stopServer(server: Server, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timer = setTimeout(() => {
      logger.warn('Þvinguð stöðvun vefþjóns eftir tímamörk');
      server.closeAllConnections?.();
      done();
    }, timeoutMs);
    timer.unref();

    server.close(() => {
      clearTimeout(timer);
      done();
    });
  });
}

export { text };
