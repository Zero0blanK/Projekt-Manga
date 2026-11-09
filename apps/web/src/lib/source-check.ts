'use client';

import { useSyncExternalStore } from 'react';
import { queryClient } from '@/lib/query-client';
import {
  openSourceBrowser,
  sourceBrowserBridge,
  sourceSessionKey,
  type SourceBrowserResult,
} from '@/lib/source-browser';

/**
 * The background browser check for each source, on the desktop app.
 *
 * When a source answers with a Cloudflare (or similar) check, the desktop app opens the
 * source's own site in a hidden window; most checks pass there by themselves and the
 * cookies they earn go to the server. Only a check that needs a click or a CAPTCHA shows
 * the window, already open. This keeps one state per source so every place that hits the
 * check (a list, a title, a library update) joins the same run and learns when it ends,
 * instead of each asking the reader to press "Open in browser".
 *
 * Runs again whenever a source is checked again later (clearances expire), but not in a
 * loop: after a check that failed, or that passed while the source still refused the app,
 * it waits before trying by itself again. The reader can always try at once.
 */

export type SourceCheckState =
  | { status: 'idle' }
  | { status: 'checking'; startedAt: number }
  /** The hidden attempt didn't pass by itself, so its window is showing for the reader. */
  | { status: 'needs-you'; startedAt: number }
  | { status: 'passed'; at: number; message: string }
  | { status: 'failed'; at: number; message: string };

/** The desktop app shows the hidden window after this long (main/source-browser.ts). */
const SHOWN_AFTER_MS = 20_000;
/** A check that failed is not started by itself again for this long. */
const RETRY_FAILED_AFTER_MS = 10 * 60_000;
/** A source that asks again this soon after a pass wasn't helped by it. */
const PASS_DID_NOT_HELP_MS = 60_000;

const IDLE: SourceCheckState = { status: 'idle' };
const states = new Map<string, SourceCheckState>();
const running = new Map<string, Promise<SourceCheckState>>();
const listeners = new Set<() => void>();
const passListeners = new Map<string, Set<() => void>>();

function setState(sourceId: string, state: SourceCheckState) {
  states.set(sourceId, state);
  for (const listener of listeners) listener();
}

export function getSourceCheck(sourceId: string): SourceCheckState {
  return states.get(sourceId) ?? IDLE;
}

export function useSourceCheck(sourceId: string): SourceCheckState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => getSourceCheck(sourceId),
    () => IDLE,
  );
}

/** Calls `listener` each time a check for this source passes, e.g. to retry what failed. */
export function onSourceCheckPassed(sourceId: string, listener: () => void): () => void {
  const set = passListeners.get(sourceId) ?? new Set();
  set.add(listener);
  passListeners.set(sourceId, set);
  return () => set.delete(listener);
}

/** Whether a check could run here at all: only the desktop app can open the window. */
export function canCheckSources(): boolean {
  return sourceBrowserBridge() !== undefined;
}

function afterPass(sourceId: string) {
  void queryClient.invalidateQueries({ queryKey: sourceSessionKey(sourceId) });
  // Everything that failed on this source can load now.
  void queryClient.invalidateQueries({
    predicate: (query) => JSON.stringify(query.queryKey).includes(JSON.stringify(sourceId)),
  });
  for (const listener of passListeners.get(sourceId) ?? []) listener();
}

/**
 * Starts the check for a source, or joins the one running.
 *
 * `auto` is for checks the app starts by itself: it skips a source whose last check
 * failed recently, and one that passed moments ago yet is asking again (the pass didn't
 * get the app through, so another would only loop). A check the reader asks for always
 * runs.
 */
export function startSourceCheck(
  sourceId: string,
  { auto }: { auto: boolean },
): Promise<SourceCheckState> | null {
  const joined = running.get(sourceId);
  if (joined) return joined;
  if (!canCheckSources()) return null;

  const previous = getSourceCheck(sourceId);
  const now = Date.now();
  if (auto && previous.status === 'failed' && now - previous.at < RETRY_FAILED_AFTER_MS) {
    return null;
  }
  if (auto && previous.status === 'passed' && now - previous.at < PASS_DID_NOT_HELP_MS) {
    setState(sourceId, {
      status: 'failed',
      at: now,
      message:
        'The browser check passed, but the source still turned the app away. Try again, or paste a session from your own browser.',
    });
    return null;
  }

  const startedAt = now;
  setState(sourceId, { status: 'checking', startedAt });
  const shown = setTimeout(() => {
    if (getSourceCheck(sourceId).status === 'checking') {
      setState(sourceId, { status: 'needs-you', startedAt });
    }
  }, SHOWN_AFTER_MS);

  const run = openSourceBrowser(sourceId, { closeWhenPassed: true })
    .then((result: SourceBrowserResult): SourceCheckState => {
      // Older desktop builds don't report `passed`; a saved session is the best they say.
      const passed = result.saved && (result.passed ?? true);
      return passed
        ? { status: 'passed', at: Date.now(), message: result.message }
        : {
            status: 'failed',
            at: Date.now(),
            message: result.saved
              ? 'The window closed before the check was passed.'
              : result.message,
          };
    })
    .catch((error: unknown): SourceCheckState => ({
      status: 'failed',
      at: Date.now(),
      message: error instanceof Error ? error.message : 'Couldn’t open the source.',
    }))
    .then((state) => {
      clearTimeout(shown);
      running.delete(sourceId);
      setState(sourceId, state);
      if (state.status === 'passed') afterPass(sourceId);
      return state;
    });
  running.set(sourceId, run);
  return run;
}

/** For tests. */
export function resetSourceChecks(): void {
  states.clear();
  running.clear();
  passListeners.clear();
  for (const listener of listeners) listener();
}
