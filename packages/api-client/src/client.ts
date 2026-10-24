// Thin fetch wrapper around the server's { success, message, data } response envelope
// (see apps/server/src/utils/responseHandlers.ts). Every domain module in this package
// is built on top of `request()` so there is exactly one place that knows how to talk
// to the server.

export type ApiErrorKind = 'network' | 'aborted' | 'timeout' | 'http';

export class ApiError extends Error {
  /** HTTP status code, or 0 for a network-level failure (no response at all). */
  status: number;
  /** 'network' — request never reached the server (offline, DNS, CORS, server down).
   *  'aborted' — cancelled via the caller's AbortSignal, not a real failure.
   *  'timeout' — no answer within the deadline; the request may still be running server-side.
   *  'http' — the server responded, just not with success. */
  kind: ApiErrorKind;

  constructor(message: string, status: number, kind: ApiErrorKind) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.kind = kind;
  }
}

export interface ApiClientConfig {
  /** Origin + path prefix for the server API, e.g. "http://localhost:4000/api". */
  baseUrl: string;
}

let configuredBaseUrl: string | null = null;

/** Call once at app startup if the default base URL resolution doesn't fit (e.g. Electron
 * pointing at a bundled server instance). */
export function configureApiClient(config: ApiClientConfig): void {
  configuredBaseUrl = config.baseUrl.replace(/\/+$/, '');
}

/** Fallback API port for server-side rendering in single-origin mode. Matches the
 * server's own `SERVER_PORT` default in apps/server/src/configs/env.ts. */
const DEFAULT_API_PORT = '4000';

/**
 * The configured base URL, exactly as given.
 *
 * This is what a *browser* should use. In single-origin mode it is relative ("/api"), and
 * it has to stay relative even when this code runs during SSR, because the thing that
 * resolves it is the browser that eventually loads the page.
 */
function resolveClientBaseUrl(): string {
  if (configuredBaseUrl) {
    return configuredBaseUrl;
  }
  const envUrl = typeof process !== 'undefined' ? process.env.NEXT_PUBLIC_API_URL : undefined;
  return (envUrl || 'http://localhost:4000/api').replace(/\/+$/, '');
}

/**
 * The base URL for a `fetch` issued by *this* process.
 *
 * Identical to the client base in a browser. On the server it additionally absolutizes a
 * relative base, because `fetch` in Node has no origin to resolve against and throws
 * "Failed to parse URL from /api/...".
 *
 * That is not hypothetical: apps/web renders manga/[id], reader/[id] and
 * discover/preview/... as Server Components that call this client during SSR and
 * `generateMetadata`. Those requests bypass the Next rewrite and address the API process
 * directly, which is what PROJEKT_MANGA_API_PORT carries (the same value next.config.ts's
 * `rewrites()` reads, so the two cannot point at different servers).
 *
 * Guarded on `typeof window` rather than an env flag so bundlers can drop this branch from
 * the browser build entirely — which is what keeps the port out of the client bundle, the
 * whole point of the relative base URL.
 */
function resolveRequestBaseUrl(): string {
  const base = resolveClientBaseUrl();

  if (base.startsWith('/') && typeof window === 'undefined') {
    const port =
      (typeof process !== 'undefined' ? process.env.PROJEKT_MANGA_API_PORT : undefined) ||
      DEFAULT_API_PORT;
    return `http://127.0.0.1:${port}${base}`;
  }

  return base;
}

function buildUrl(path: string, query?: QueryParams, base = resolveRequestBaseUrl()): string {
  let url = `${base}/${path.replace(/^\/+/, '')}`;

  if (query) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) {
        continue;
      }
      params.set(key, String(value));
    }
    const qs = params.toString();
    if (qs) {
      url += `?${qs}`;
    }
  }

  return url;
}

export type QueryParams = Record<string, string | number | boolean | undefined | null>;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  query?: QueryParams;
  body?: unknown;
  signal?: AbortSignal;
  headers?: HeadersInit;
  cache?: RequestCache;
  /** Overrides DEFAULT_TIMEOUT_MS for this call. Pass 0 to wait indefinitely — only
   * appropriate for a request the reader explicitly started and can cancel themselves. */
  timeoutMs?: number;
}

interface ResponseEnvelope<T> {
  success: boolean;
  message?: string;
  data?: T;
}

/**
 * How long any request waits before giving up.
 *
 * Without a deadline, a request that reached the server but never got an answer (a slow
 * scrape, an upstream that accepted the connection and stalled) would leave the UI
 * spinning indefinitely.
 *
 * Comfortably longer than the server's own 15s per-source axios timeout, so a legitimately
 * slow scrape (which the server may retry) still completes rather than being cut off here
 * and reported as a failure it isn't.
 */
const DEFAULT_TIMEOUT_MS = 45_000;

/** Composes the caller's cancellation with our deadline. Returns the caller's signal
 * unchanged when there is no deadline, so a request that opts out costs nothing. */
function withDeadline(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal | undefined {
  if (timeoutMs <= 0) return signal;
  const deadline = AbortSignal.timeout(timeoutMs);
  if (!signal) return deadline;
  // AbortSignal.any is available in every runtime this app targets (modern Chromium for
  // both the browser and Electron); fall back to the caller's own signal rather than
  // dropping their ability to cancel.
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, deadline]) : signal;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const {
    method = 'GET',
    query,
    body,
    signal,
    headers,
    cache,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;
  const url = buildUrl(path, query);

  // Sends the session cookie on cross-origin requests (web on :3000, server on :4000 —
  // different origins even on the same machine). Requires the server's CORS config to
  // set an explicit origin + credentials: true — '*' is spec-incompatible with this.
  const init: RequestInit = {
    method,
    signal: withDeadline(signal, timeoutMs),
    credentials: 'include',
    headers,
    cache,
  };
  if (body !== undefined) {
    const requestHeaders = new Headers(headers);
    requestHeaders.set('Content-Type', 'application/json');
    init.headers = requestHeaders;
    init.body = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    // A deadline that fires surfaces as TimeoutError, and must not be reported as
    // "cancelled" — nobody cancelled it, and the reader needs to know the difference
    // between "I navigated away" and "this source never answered".
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new ApiError(
        'This took too long to respond. The source may be slow or unreachable — try again.',
        0,
        'timeout',
      );
    }
    if (error instanceof Error && error.name === 'AbortError') {
      // A caller-cancelled request whose own signal is not aborted was cancelled by our
      // composed deadline instead (some runtimes report the composite as AbortError).
      if (signal?.aborted !== true) {
        throw new ApiError(
          'This took too long to respond. The source may be slow or unreachable — try again.',
          0,
          'timeout',
        );
      }
      throw new ApiError('Request cancelled', 0, 'aborted');
    }
    throw new ApiError(describeNetworkFailure(), 0, 'network');
  }

  let envelope: ResponseEnvelope<T> | null = null;
  try {
    envelope = (await response.json()) as ResponseEnvelope<T>;
  } catch {
    // No/invalid JSON body — fall through and report using the HTTP status alone.
  }

  if (!response.ok || !envelope?.success) {
    throw new ApiError(
      envelope?.message || `Request failed with status ${response.status}`,
      response.status,
      'http',
    );
  }

  return envelope.data as T;
}

/** The browser's fetch() TypeError (e.g. "NetworkError when attempting to fetch
 * resource", "Failed to fetch") carries no useful detail — check navigator.onLine where
 * available for a message the user can actually act on. */
function describeNetworkFailure(): string {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return "You're offline. Check your internet connection and try again.";
  }
  return 'Unable to reach the server. It may be down, or unreachable from your network — try again shortly.';
}

/**
 * URL for an endpoint the caller hands to the *browser* rather than fetching itself — an
 * `<img src>`, an `EventSource`, or a base URL shown in the UI.
 *
 * Deliberately built from the client base, not the request base. Using the request base
 * here produced absolute loopback URLs (`http://127.0.0.1:4000/api/source/image-proxy?...`)
 * whenever a cover was rendered by a Server Component; the browser then asked next/image to
 * optimize an absolute URL, which single-origin mode's empty `remotePatterns` rejects with
 * a 400. A relative src is a local image, which is what the config expects.
 */
export function buildApiUrl(path: string, query?: QueryParams): string {
  return buildUrl(path, query, resolveClientBaseUrl());
}
