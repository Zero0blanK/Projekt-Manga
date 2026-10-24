'use client';

import { ApiError } from '@projekt-manga/api-client';
import { toast } from '@/hooks/use-toast';

/**
 * Tells the reader something failed, once, in words they can act on.
 *
 * Swallowing a failure leaves a screen that finishes loading and simply shows nothing,
 * which reads as "you have no history" or "this title has no chapters" rather than "that
 * request failed", and gives no hint that retrying might help.
 *
 * Not every failure belongs here. The rule this codebase follows:
 *
 * - **Primary content** — the thing the screen exists to show. Report it.
 * - **Decorative or secondary data** — download badges, folder paths, cover-cache
 *   refreshes. Stay silent; the screen is still useful without them, and a toast for
 *   each would train the reader to ignore toasts.
 * - **Cancelled requests** — never. Navigating away or changing a filter aborts the
 *   in-flight request every time; that is the app working correctly.
 */

const recentlyReported = new Map<string, number>();

/** Long enough to collapse the burst from one action (several components loading the same
 * data at once), short enough that a deliberate retry still gets an answer. */
const DEDUPE_MS = 8_000;

/** True for a request the app itself cancelled — an aborted fetch is not a failure. */
export function isAborted(error: unknown): boolean {
  return error instanceof ApiError && error.kind === 'aborted';
}

/**
 * @param error   what was thrown; an ApiError contributes its own message
 * @param message what the reader needs to know, in the app's own words
 */
export function reportError(error: unknown, message: string): void {
  if (isAborted(error)) return;

  // The api-client's messages are already reader-facing (offline, timeout, the server's
  // own message), so they add real detail rather than a stack trace.
  const detail = error instanceof ApiError ? error.message : null;
  const description = detail ? `${message} ${detail}` : message;

  const now = Date.now();
  for (const [key, at] of recentlyReported) {
    if (now - at >= DEDUPE_MS) recentlyReported.delete(key);
  }
  if (recentlyReported.has(description)) return;
  recentlyReported.set(description, now);

  toast({ variant: 'destructive', description });
}
