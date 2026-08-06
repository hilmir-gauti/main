/**
 * A small path router with typed params and onion-style middleware.
 *
 * Routes are compiled to regular expressions once at registration time.
 * Matching is linear over the registered routes, which is entirely adequate
 * for the couple of hundred routes this platform exposes and keeps the
 * behaviour obvious: first registered match wins.
 */

import type { RequestContext } from './context.ts';
import type { HttpResponse } from './response.ts';

export type Handler = (ctx: RequestContext) => Promise<HttpResponse> | HttpResponse;
export type Middleware = (ctx: RequestContext, next: () => Promise<HttpResponse>) => Promise<HttpResponse>;

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

interface Route {
  method: Method;
  pattern: RegExp;
  paramNames: string[];
  handler: Handler;
  middleware: Middleware[];
  /** Original path, kept for logging and route listings. */
  path: string;
}

/**
 * Compiles "/tenants/:id/bookings" into a regex with a named capture per
 * parameter. A trailing "*rest" captures the remainder of the path, which is
 * how static file mounts work.
 */
function compile(path: string): { pattern: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const source = path
    .split('/')
    .filter((segment, index) => index === 0 || segment !== '')
    .map((segment) => {
      if (segment.startsWith('*')) {
        paramNames.push(segment.slice(1) || 'rest');
        return '/(.*)';
      }
      if (segment.startsWith(':')) {
        paramNames.push(segment.slice(1));
        return '/([^/]+)';
      }
      if (segment === '') return '';
      return `/${segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;
    })
    .join('');

  return { pattern: new RegExp(`^${source || '/'}/?$`), paramNames };
}

export class Router {
  private readonly routes: Route[] = [];
  private readonly globalMiddleware: Middleware[] = [];

  /** Registers middleware that runs for every request, in registration order. */
  use(middleware: Middleware): this {
    this.globalMiddleware.push(middleware);
    return this;
  }

  add(method: Method, path: string, handler: Handler, middleware: Middleware[] = []): this {
    const { pattern, paramNames } = compile(path);
    this.routes.push({ method, pattern, paramNames, handler, middleware, path });
    return this;
  }

  get(path: string, handler: Handler, middleware: Middleware[] = []): this {
    return this.add('GET', path, handler, middleware);
  }
  post(path: string, handler: Handler, middleware: Middleware[] = []): this {
    return this.add('POST', path, handler, middleware);
  }
  put(path: string, handler: Handler, middleware: Middleware[] = []): this {
    return this.add('PUT', path, handler, middleware);
  }
  patch(path: string, handler: Handler, middleware: Middleware[] = []): this {
    return this.add('PATCH', path, handler, middleware);
  }
  delete(path: string, handler: Handler, middleware: Middleware[] = []): this {
    return this.add('DELETE', path, handler, middleware);
  }

  /** Merges another router's routes underneath `prefix`. */
  mount(prefix: string, router: Router): this {
    const clean = prefix.replace(/\/+$/, '');
    for (const route of router.routes) {
      const path = route.path === '/' ? clean || '/' : `${clean}${route.path}`;
      this.add(route.method, path, route.handler, [...router.globalMiddleware, ...route.middleware]);
    }
    return this;
  }

  /** All registered routes — used by the admin console's route listing. */
  list(): Array<{ method: Method; path: string }> {
    return this.routes.map((r) => ({ method: r.method, path: r.path }));
  }

  /**
   * Finds a matching route and runs it through the middleware chain.
   * Returns null when nothing matched, so the caller decides on 404 vs. 405.
   */
  async handle(ctx: RequestContext, notFoundHandler: Handler): Promise<HttpResponse> {
    // HEAD is served by the GET handler; the server strips the body.
    const method = ctx.method === 'HEAD' ? 'GET' : ctx.method;

    let pathMatchedOtherMethod = false;

    for (const route of this.routes) {
      const match = route.pattern.exec(ctx.path);
      if (!match) continue;
      if (route.method !== method) {
        pathMatchedOtherMethod = true;
        continue;
      }

      const params: Record<string, string> = {};
      route.paramNames.forEach((name, index) => {
        const value = match[index + 1];
        if (value !== undefined) {
          try {
            params[name] = decodeURIComponent(value);
          } catch {
            params[name] = value;
          }
        }
      });
      ctx.params = params;
      ctx.routePath = route.path;

      return runChain([...this.globalMiddleware, ...route.middleware], ctx, () =>
        Promise.resolve(route.handler(ctx)),
      );
    }

    ctx.params = {};
    if (pathMatchedOtherMethod) {
      return runChain([...this.globalMiddleware], ctx, async () => ({
        status: 405,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body: 'Aðferð ekki leyfð.',
      }));
    }

    return runChain([...this.globalMiddleware], ctx, () => Promise.resolve(notFoundHandler(ctx)));
  }
}

function runChain(
  middleware: readonly Middleware[],
  ctx: RequestContext,
  final: () => Promise<HttpResponse>,
): Promise<HttpResponse> {
  let index = -1;

  const dispatch = (i: number): Promise<HttpResponse> => {
    // Guards against a middleware calling next() twice, which would otherwise
    // run downstream handlers (and their side effects) more than once.
    if (i <= index) return Promise.reject(new Error('next() kallað oftar en einu sinni í middleware'));
    index = i;

    const fn = middleware[i];
    if (!fn) return final();
    return Promise.resolve(fn(ctx, () => dispatch(i + 1)));
  };

  return dispatch(0);
}
