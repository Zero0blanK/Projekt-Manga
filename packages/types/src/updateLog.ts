import type { SourceErrorCode } from './extension.js';

/**
 * The axis the update log filters on. Mostly the source error codes, plus `UNCLASSIFIED`
 * for failures that never went through the source classifier — rows written before this
 * format existed, and errors raised outside a source call (a persistence failure mid
 * update). Folding those into `UPSTREAM_ERROR` would claim the source returned something
 * it never did.
 */
export type UpdateLogCategory = SourceErrorCode | 'UNCLASSIFIED';

/**
 * Structured diagnostics for a failed library update, stored in `update_log.detail`.
 *
 * That column is free-form text and its contents have only ever been rendered, never
 * queried — so this replaces the previous bare `error.message` with something the UI can
 * categorise and filter without needing a new column. Rows written before this format
 * existed are plain prose; `parseUpdateLogDetail` reads those back as `UNCLASSIFIED` with
 * the original text as their summary, so old entries still render correctly.
 *
 * If update logs ever need to be filtered or aggregated on the *server*, this should
 * become an indexed `category` column instead — JSON in a text field can't be indexed.
 */
export interface UpdateLogDetail {
  /** Format version, so a future change can be told apart from v1 rows. */
  v: 1;
  /** Which class of failure this was — the axis the UI filters on. */
  category: UpdateLogCategory;
  /** Short label for the specific failure, e.g. "Cloudflare challenge", "DNS lookup
   * failed", "HTTP 404". More precise than `category` and safe to show as a badge. */
  reason: string;
  /** One sentence a reader can act on. */
  summary: string;
  /** The underlying technical error text — the axios/network message, or the parser's
   * complaint (e.g. "Unexpected token < in JSON at position 0"). Undefined when the
   * failure carried nothing beyond its summary. */
  cause?: string;
  /** HTTP status, when the failure came back with a response. */
  status?: number;
  /** Request URL, query string stripped — some sources carry tokens there. */
  url?: string;
}

export const UPDATE_LOG_CATEGORIES: UpdateLogCategory[] = [
  'NETWORK_ERROR',
  'TIMEOUT',
  'BLOCKED',
  'RATE_LIMITED',
  'NOT_FOUND',
  'PARSE_ERROR',
  'UPSTREAM_ERROR',
  'UNCLASSIFIED',
];

export const UPDATE_LOG_CATEGORY_LABELS: Record<UpdateLogCategory, string> = {
  NETWORK_ERROR: 'Network',
  TIMEOUT: 'Timeout',
  BLOCKED: 'Blocked',
  RATE_LIMITED: 'Rate limited',
  NOT_FOUND: 'Not found',
  PARSE_ERROR: 'Parse error',
  UPSTREAM_ERROR: 'Server error',
  UNCLASSIFIED: 'Unclassified',
};

/** What each category means, for the filter UI's tooltips. */
export const UPDATE_LOG_CATEGORY_HINTS: Record<UpdateLogCategory, string> = {
  NETWORK_ERROR: "Couldn't reach the source at all — DNS, connection refused, or no route",
  TIMEOUT: 'The source accepted the connection but never finished responding',
  BLOCKED: 'Anti-bot protection rejected the request (Cloudflare, CAPTCHA, or a soft ban)',
  RATE_LIMITED: 'Too many requests — the source asked us to slow down',
  NOT_FOUND: 'The source returned 404 for this title',
  PARSE_ERROR: "The response arrived but didn't look like what the extension expected",
  UPSTREAM_ERROR: 'The source returned a server error or an unexpected status',
  UNCLASSIFIED: 'Recorded before errors were categorised, or raised outside a source call',
};

function isCategory(value: unknown): value is UpdateLogCategory {
  return typeof value === 'string' && (UPDATE_LOG_CATEGORIES as string[]).includes(value);
}

/**
 * Reads `update_log.detail` back into structured form, tolerating the plain-text rows
 * written before this format existed.
 */
export function parseUpdateLogDetail(detail: string): UpdateLogDetail {
  const fallback = (summary: string): UpdateLogDetail => ({
    v: 1,
    category: 'UNCLASSIFIED',
    reason: 'Unclassified',
    summary: summary || 'No further detail was recorded.',
  });

  const trimmed = (detail ?? '').trim();
  if (!trimmed.startsWith('{')) return fallback(trimmed);

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null) return fallback(trimmed);
    const record = parsed as Record<string, unknown>;
    if (!isCategory(record.category)) return fallback(trimmed);
    return {
      v: 1,
      category: record.category,
      reason:
        typeof record.reason === 'string'
          ? record.reason
          : UPDATE_LOG_CATEGORY_LABELS[record.category],
      summary: typeof record.summary === 'string' ? record.summary : '',
      cause: typeof record.cause === 'string' ? record.cause : undefined,
      status: typeof record.status === 'number' ? record.status : undefined,
      url: typeof record.url === 'string' ? record.url : undefined,
    };
  } catch {
    return fallback(trimmed);
  }
}
