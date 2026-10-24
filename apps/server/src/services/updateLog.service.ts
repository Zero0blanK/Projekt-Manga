import updateLogRepository from '../repositories/updateLog.repository.js';
import type { UpdateLogCategory, SourceErrorCode, UpdateLogDetail } from '@projekt-manga/types';
import { UPDATE_LOG_CATEGORY_LABELS } from '@projekt-manga/types';

const DEFAULT_LIMIT = 50;

const getRecent = async (limit?: number) => {
  return await updateLogRepository.listRecent(limit ?? DEFAULT_LIMIT);
};

const logNewChapters = async (
  source_id: string,
  manga_id: string,
  mangaTitle: string,
  count: number,
) => {
  return await updateLogRepository.create({
    source_id,
    manga_id,
    kind: 'NEW_CHAPTER',
    message: `Found ${count} new chapter${count === 1 ? '' : 's'} for "${mangaTitle}"`,
    detail: `Checked ${source_id} and found ${count} chapter${count === 1 ? '' : 's'} newer than what's in the library. Chapter list refreshed.`,
  });
};

/** Shape thrown by apps/extensions' `classifyRequestError`. Matched structurally rather
 * than with `instanceof` — the extensions package is loaded dynamically, so the class
 * identity here isn't guaranteed to be the same one the source threw. */
interface ClassifiedSourceError {
  code: SourceErrorCode;
  message: string;
  reason?: string;
  detail?: string;
  statusCode?: number;
  url?: string;
}

const SOURCE_CODES: SourceErrorCode[] = [
  'NETWORK_ERROR',
  'TIMEOUT',
  'BLOCKED',
  'RATE_LIMITED',
  'NOT_FOUND',
  'PARSE_ERROR',
  'UPSTREAM_ERROR',
];

function isClassified(error: unknown): error is ClassifiedSourceError {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return (
    typeof candidate.message === 'string' &&
    typeof candidate.code === 'string' &&
    SOURCE_CODES.includes(candidate.code as SourceErrorCode)
  );
}

/** A last-resort classification for errors that never went through the source classifier
 * (a bug in the persistence path, a Prisma failure mid-update). Reads the message rather
 * than guessing, so "unable to resolve host" doesn't get filed as a parse error. */
function classifyLoosely(text: string): { category: UpdateLogCategory; reason: string } {
  const checks: Array<[RegExp, UpdateLogCategory, string]> = [
    [/etimedout|timed? ?out|deadline exceeded/i, 'TIMEOUT', 'Request timed out'],
    [/enotfound|getaddrinfo|eai_again|dns/i, 'NETWORK_ERROR', 'Unable to resolve host'],
    [
      /econnrefused|econnreset|ehostunreach|enetunreach|socket hang up/i,
      'NETWORK_ERROR',
      'Connection failed',
    ],
    [/cloudflare|ddos-guard|captcha|just a moment/i, 'BLOCKED', 'Anti-bot challenge'],
    [/\b429\b|rate.?limit/i, 'RATE_LIMITED', 'Rate limited'],
    [/\b404\b|not found/i, 'NOT_FOUND', 'HTTP 404'],
    [/json|unexpected token|cheerio|selector|parse/i, 'PARSE_ERROR', 'Malformed response'],
    [/\b5\d\d\b/, 'UPSTREAM_ERROR', 'Server error'],
  ];
  for (const [pattern, category, reason] of checks) {
    if (pattern.test(text)) return { category, reason };
  }
  return { category: 'UNCLASSIFIED', reason: 'Unclassified' };
}

/**
 * Records why a title failed to update, with enough detail to act on.
 *
 * `error.message` alone is, for a classified source error, only the *end-user* sentence
 * ("returned an unexpected response"). The cause, HTTP status and request URL are what
 * tell a timeout from a Cloudflare challenge from a 404, so the full diagnostic is
 * serialised into `detail` (see `UpdateLogDetail`) and the category is what the UI
 * filters on.
 */
const logError = async (
  source_id: string,
  manga_id: string | undefined,
  mangaTitle: string | undefined,
  error: unknown,
) => {
  const classified = isClassified(error);
  const rawMessage = error instanceof Error ? error.message : String(error);

  const category: UpdateLogCategory = classified
    ? error.code
    : classifyLoosely(rawMessage).category;
  const reason = classified
    ? (error.reason ?? UPDATE_LOG_CATEGORY_LABELS[category])
    : classifyLoosely(rawMessage).reason;
  const summary = classified ? error.message : rawMessage;
  const cause = classified ? error.detail : undefined;

  const payload: UpdateLogDetail = {
    v: 1,
    category,
    reason,
    summary,
    ...(cause && cause !== summary ? { cause } : {}),
    ...(classified && error.statusCode ? { status: error.statusCode } : {}),
    ...(classified && error.url ? { url: error.url } : {}),
  };

  return await updateLogRepository.create({
    source_id,
    manga_id: manga_id ?? null,
    kind: 'ERROR',
    // The category is in the headline too, so the list reads usefully before anything is
    // expanded: `Failed to update "X" — Cloudflare challenge`.
    message: mangaTitle
      ? `Failed to update "${mangaTitle}" — ${reason}`
      : `${source_id} failed to update — ${reason}`,
    detail: JSON.stringify(payload),
  });
};

const updateLogService = {
  getRecent,
  logNewChapters,
  logError,
};

export default updateLogService;
