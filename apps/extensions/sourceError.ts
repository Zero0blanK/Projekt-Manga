import type { AxiosError } from 'axios';
import type { SourceErrorCode } from '@projekt-manga/types';
import { CLOUDFLARE_PATTERNS, CAPTCHA_PATTERNS } from './utils/detectionPatterns.js';

/**
 * Thrown by a source instead of silently returning an empty result, so callers (and the
 * UI) can tell "this manga has no chapters" apart from "the source is unreachable,
 * blocking us, or changed its layout".
 */
export class SourceError extends Error {
  code: SourceErrorCode;
  sourceId: string;
  statusCode?: number;
  /** Short label for the *specific* failure within `code` — "Cloudflare challenge" rather
   * than just "Blocked", "DNS lookup failed" rather than just "Network". Surfaced in the
   * update log so a reader can tell two blocked-by-different-things failures apart. */
  reason?: string;
  /** The underlying technical message: the axios/network error, or the parser's
   * complaint. Kept separate from `message`, which is written for the end user. */
  detail?: string;
  /** Request URL with the query string stripped — some sources put tokens there. */
  url?: string;

  constructor(
    code: SourceErrorCode,
    message: string,
    sourceId: string,
    options?: {
      statusCode?: number;
      cause?: unknown;
      reason?: string;
      detail?: string;
      url?: string;
    },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'SourceError';
    this.code = code;
    this.sourceId = sourceId;
    this.statusCode = options?.statusCode;
    this.reason = options?.reason;
    this.detail = options?.detail;
    this.url = options?.url;
  }
}

function isAxiosErrorLike(error: unknown): error is AxiosError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'isAxiosError' in error &&
    (error as { isAxiosError?: unknown }).isAxiosError === true
  );
}

/** Names the specific block using the shared patterns from utils/detectionPatterns.ts
 * (a dependency-free leaf module, so importing it adds no cycles). */
function describeBlock(body: string, status?: number): string {
  if (/ddos-guard/i.test(body)) {
    return 'DDoS-Guard challenge';
  }
  if (CLOUDFLARE_PATTERNS.some((pattern) => pattern.test(body))) {
    return 'Cloudflare challenge';
  }
  if (CAPTCHA_PATTERNS.some((pattern) => pattern.test(body))) {
    return 'CAPTCHA required';
  }
  return status === 403 ? 'Forbidden (403)' : 'Service unavailable (503)';
}

/** Response bodies can be megabytes of HTML; only a slice is ever useful in a log. */
function bodySnippet(data: unknown): string {
  if (typeof data !== 'string') return '';
  return data.slice(0, 4000);
}

/** Strips the query string — some sources carry API tokens there, and the path alone is
 * what's diagnostic. */
function safeUrl(error: AxiosError): string | undefined {
  const raw = error.config?.url;
  if (!raw) return undefined;
  try {
    const base = error.config?.baseURL;
    const parsed = new URL(raw, base || 'https://placeholder.invalid');
    return parsed.host === 'placeholder.invalid'
      ? parsed.pathname
      : `${parsed.origin}${parsed.pathname}`;
  } catch {
    return raw.split('?')[0];
  }
}

/** Human-readable labels for Node/undici network error codes. */
const NETWORK_REASONS: Record<string, string> = {
  ENOTFOUND: 'Unable to resolve host',
  EAI_AGAIN: 'DNS lookup failed (temporary)',
  ECONNREFUSED: 'Connection refused',
  ECONNRESET: 'Connection reset by peer',
  EHOSTUNREACH: 'Host unreachable',
  ENETUNREACH: 'Network unreachable',
  EPIPE: 'Connection closed early',
  ECONNABORTED: 'Request aborted',
  ETIMEDOUT: 'Connection timed out',
  CERT_HAS_EXPIRED: 'TLS certificate expired',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS certificate not trusted',
};

/**
 * Turns a raw axios/network error into a classified SourceError, so every source applies
 * the same classification rules.
 */
export function classifyRequestError(
  error: unknown,
  sourceId: string,
  sourceName: string,
): SourceError {
  if (error instanceof SourceError) {
    return error;
  }

  if (isAxiosErrorLike(error)) {
    const status = error.response?.status;
    const netCode = error.code;
    const url = safeUrl(error);
    const detail = error.message;

    // No response at all: DNS failure, connection refused, or no network path.
    if (
      netCode === 'ENOTFOUND' ||
      netCode === 'ECONNREFUSED' ||
      netCode === 'ECONNRESET' ||
      netCode === 'EAI_AGAIN' ||
      (!status && !netCode)
    ) {
      return new SourceError(
        'NETWORK_ERROR',
        `Could not reach ${sourceName}. Check your internet connection or try again later.`,
        sourceId,
        {
          cause: error,
          reason: (netCode && NETWORK_REASONS[netCode]) || 'No response from host',
          detail,
          url,
        },
      );
    }

    if (
      netCode === 'ECONNABORTED' ||
      netCode === 'ETIMEDOUT' ||
      /timeout/i.test(error.message || '')
    ) {
      // Axios reports its own timeout as ECONNABORTED, so NETWORK_REASONS' "Request
      // aborted" would mislead; surface the configured limit instead.
      const limit = /timeout of (\d+)ms/i.exec(error.message || '')?.[1];
      return new SourceError(
        'TIMEOUT',
        `${sourceName} took too long to respond. Try again.`,
        sourceId,
        {
          cause: error,
          reason: limit
            ? `Timed out after ${limit}ms`
            : netCode === 'ETIMEDOUT'
              ? 'Connection timed out'
              : 'Request timed out',
          detail,
          url,
        },
      );
    }

    if (netCode && NETWORK_REASONS[netCode]) {
      return new SourceError(
        'NETWORK_ERROR',
        `Could not reach ${sourceName}. Check your internet connection or try again later.`,
        sourceId,
        {
          cause: error,
          reason: NETWORK_REASONS[netCode],
          detail,
          url,
        },
      );
    }

    if (status === 404) {
      return new SourceError('NOT_FOUND', `Not found on ${sourceName}.`, sourceId, {
        statusCode: status,
        cause: error,
        reason: 'HTTP 404',
        detail,
        url,
      });
    }

    if (status === 429) {
      const retryAfter = error.response?.headers?.['retry-after'];
      return new SourceError(
        'RATE_LIMITED',
        `Too many requests to ${sourceName}. Please wait and try again.`,
        sourceId,
        {
          statusCode: status,
          cause: error,
          reason: retryAfter ? `HTTP 429 — retry after ${retryAfter}s` : 'HTTP 429',
          detail,
          url,
        },
      );
    }

    if (status === 401 || status === 403 || status === 503) {
      const reason =
        status === 401
          ? 'Unauthorized (401)'
          : describeBlock(bodySnippet(error.response?.data), status);
      return new SourceError(
        'BLOCKED',
        `${sourceName} blocked this request (anti-bot protection). Try again later.`,
        sourceId,
        {
          statusCode: status,
          cause: error,
          reason,
          detail,
          url,
        },
      );
    }

    if (status && status >= 500) {
      return new SourceError('UPSTREAM_ERROR', `${sourceName} returned a server error.`, sourceId, {
        statusCode: status,
        cause: error,
        reason: `HTTP ${status}`,
        detail,
        url,
      });
    }

    if (status) {
      return new SourceError(
        'UPSTREAM_ERROR',
        `${sourceName} returned an unexpected response (${status}).`,
        sourceId,
        {
          statusCode: status,
          cause: error,
          reason: `HTTP ${status}`,
          detail,
          url,
        },
      );
    }

    return new SourceError(
      'NETWORK_ERROR',
      `Could not reach ${sourceName}. Check your internet connection or try again later.`,
      sourceId,
      {
        cause: error,
        reason: netCode || 'No response from host',
        detail,
        url,
      },
    );
  }

  // Not a network error: most likely a selector/JSON-shape assumption that no longer
  // matches the source's response.
  const detail = error instanceof Error ? error.message : String(error);
  const reason = /json|unexpected token/i.test(detail)
    ? 'Malformed JSON response'
    : /no matching|selector|element/i.test(detail)
      ? 'Expected elements missing from page'
      : 'Unexpected response shape';
  return new SourceError(
    'PARSE_ERROR',
    `${sourceName} returned unexpected data — it may have changed its layout.`,
    sourceId,
    {
      cause: error,
      reason,
      detail,
    },
  );
}
