/**
 * Shared HTTP client for outbound integrations.
 *
 * Adds the things every provider call needs and none of them provide:
 * a timeout, bounded retries with jittered backoff on transient failures, and
 * error messages that name the provider so a 401 from Google is never mistaken
 * for one from Twilio.
 */

import { IntegrationError } from '../core/errors.ts';
import { logger } from '../core/logger.ts';

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | URLSearchParams;
  timeoutMs?: number;
  /** Attempts in total, including the first. */
  retries?: number;
  /** Treated as success rather than an error (e.g. 404 when deleting). */
  tolerate?: number[];
}

export interface ProviderResponse<T> {
  status: number;
  data: T;
  ok: boolean;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function backoffMs(attempt: number): number {
  // 500ms, 1s, 2s … with up to 250ms of jitter so retries do not synchronise.
  return Math.min(8000, 500 * 2 ** (attempt - 1)) + Math.random() * 250;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function requestJson<T = unknown>(
  provider: string,
  url: string,
  options: RequestOptions = {},
): Promise<ProviderResponse<T>> {
  const attempts = Math.max(1, options.retries ?? 3);
  const timeoutMs = options.timeoutMs ?? 15_000;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: options.method ?? 'GET',
        headers: {
          accept: 'application/json',
          ...(options.body instanceof URLSearchParams
            ? { 'content-type': 'application/x-www-form-urlencoded' }
            : options.body
              ? { 'content-type': 'application/json' }
              : {}),
          ...options.headers,
        },
        body: options.body,
        signal: controller.signal,
      });

      const text = await response.text();
      let data: T;
      try {
        data = (text ? JSON.parse(text) : null) as T;
      } catch {
        data = text as unknown as T;
      }

      if (response.ok || options.tolerate?.includes(response.status)) {
        return { status: response.status, data, ok: true };
      }

      if (RETRYABLE_STATUS.has(response.status) && attempt < attempts) {
        const wait = response.status === 429
          ? Number(response.headers.get('retry-after')) * 1000 || backoffMs(attempt)
          : backoffMs(attempt);
        logger.warn('Ytri þjónusta svaraði með villu — reyni aftur', {
          provider, url: redactUrl(url), status: response.status, attempt, waitMs: Math.round(wait),
        });
        await sleep(wait);
        continue;
      }

      throw new IntegrationError(provider, `HTTP ${response.status}: ${text.slice(0, 500)}`, {
        status: response.status >= 500 ? 502 : response.status,
        details: { status: response.status },
      });
    } catch (error) {
      lastError = error;
      if (error instanceof IntegrationError) throw error;

      const isAbort = error instanceof Error && error.name === 'AbortError';
      if (attempt < attempts) {
        logger.warn('Beiðni til ytri þjónustu mistókst — reyni aftur', {
          provider, url: redactUrl(url), attempt, reason: isAbort ? 'tímamörk' : String(error),
        });
        await sleep(backoffMs(attempt));
        continue;
      }
      throw new IntegrationError(provider, isAbort ? `Tímamörk eftir ${timeoutMs}ms` : String(error), { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }

  throw new IntegrationError(provider, `Beiðni mistókst: ${String(lastError)}`, { cause: lastError });
}

/** Strips query strings, which routinely carry tokens, before logging a URL. */
function redactUrl(url: string): string {
  const index = url.indexOf('?');
  return index === -1 ? url : `${url.slice(0, index)}?…`;
}
