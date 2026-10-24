import { RateLimitedError, UpstreamError } from '../../utils/customErrors.js';

/**
 * Retry/backoff shared by every tracker adapter's HTTP layer.
 *
 * Both AniList and MyAnimeList rate-limit, and both answer a 429 by saying how long to
 * wait. Without a dedicated retry, a 429 would look like a connection failure and be
 * retried identically on the next poll, so a library large enough to trip the limit could
 * never finish a sync.
 *
 * Only 429 is retried. A 4xx is a real request error that retrying can't fix, and a 5xx
 * is left to the caller's own best-effort handling rather than piling extra load onto an
 * upstream that's already failing.
 */

const MAX_ATTEMPTS = 3;

// Used only when a 429 arrives with no usable Retry-After/X-RateLimit-Reset — both APIs
// normally send one, but neither documents it as guaranteed.
const FALLBACK_BACKOFF_MS = [1_000, 5_000];

// A tracker asking for a longer wait than this isn't worth holding a poll cycle (or a
// user's "Sync now" request) open for — give up and let the next cycle pick the link up,
// which is exactly what the cycle's oldest-first ordering is for.
const MAX_WAIT_MS = 30_000;

type ResponseHeaders = Record<string, unknown> | undefined;

/**
 * The response status of a failed HTTP call, or null if this wasn't one.
 *
 * Deliberately duck-typed instead of using `axios.isAxiosError`: the server test suite
 * mocks axios as a bare `{ default: { get, post, patch } }`, so the real module's helper
 * functions don't exist there and calling one would throw inside the error path — the
 * one place that must never throw for the wrong reason.
 */
function statusOf(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }
  const response = (error as { response?: { status?: unknown } }).response;
  if (typeof response !== 'object' || response === null) {
    return null;
  }
  const status = (response as { status?: unknown }).status;
  return typeof status === 'number' ? status : null;
}

function headersOf(error: unknown): ResponseHeaders {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const response = (error as { response?: { headers?: unknown } }).response;
  if (typeof response !== 'object' || response === null) {
    return undefined;
  }
  const headers = (response as { headers?: unknown }).headers;
  return typeof headers === 'object' && headers !== null
    ? (headers as Record<string, unknown>)
    : undefined;
}

export function isRateLimited(error: unknown): boolean {
  return statusOf(error) === 429;
}

function headerValue(headers: ResponseHeaders, name: string): string | null {
  if (!headers) {
    return null;
  }
  // Axios lowercases response header names, but a mocked or proxied response might not.
  const raw = headers[name] ?? headers[name.toUpperCase()];
  if (typeof raw === 'string' || typeof raw === 'number') {
    return String(raw);
  }
  return null;
}

/**
 * How long a 429 wants us to wait, in ms, or null if it didn't say.
 *
 * `Retry-After` is either delta-seconds or an HTTP date (RFC 9110 allows both), and
 * AniList additionally sends `X-RateLimit-Reset` as a unix timestamp in *seconds*.
 * `now` is a parameter purely so the date-based branches are testable without clock
 * games.
 */
export function retryAfterMs(headers: ResponseHeaders, now: number = Date.now()): number | null {
  const retryAfter = headerValue(headers, 'retry-after');
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      return Math.max(0, seconds * 1000);
    }
    const asDate = Date.parse(retryAfter);
    if (!Number.isNaN(asDate)) {
      return Math.max(0, asDate - now);
    }
  }

  const reset = Number(headerValue(headers, 'x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) {
    return Math.max(0, reset * 1000 - now);
  }
  return null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `fn`, retrying only on 429 and only for as long as the tracker asked. Any other
 * failure propagates on the first attempt so the caller sees it immediately.
 */
export async function requestWithRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const isLastAttempt = attempt >= MAX_ATTEMPTS - 1;
      if (!isRateLimited(error) || isLastAttempt) {
        throw error;
      }
      const wait = retryAfterMs(headersOf(error)) ?? FALLBACK_BACKOFF_MS[attempt] ?? MAX_WAIT_MS;
      if (wait > MAX_WAIT_MS) {
        throw error;
      }
      await sleep(wait);
    }
  }
}

/**
 * Translates a failed tracker call into this app's own error vocabulary. A 429 becomes a
 * RateLimitedError so it reaches the client as a 429 with a message a reader can act on
 * ("wait and try again") rather than a generic upstream failure they'd retry immediately.
 */
export function toTrackerError(error: unknown, label: string): never {
  if (isRateLimited(error)) {
    throw new RateLimitedError(
      `${label} is rate-limiting this app right now — try again in a minute.`,
    );
  }
  throw new UpstreamError(
    `${label} request failed: ${error instanceof Error ? error.message : String(error)}`,
  );
}
