'use client';

import {
  ApiError,
  getSourceBrowserSession,
  getSourceHealth,
  getSourceMangaPage,
  getSources,
} from '@projekt-manga/api-client';
import { getSetting } from '@/lib/app-store';
import { AUTO_OPEN_CHALLENGE_SETTING, CHALLENGE_REQUIRED } from '@/lib/source-browser';
import {
  canCheckSources,
  getSourceCheck,
  runningSourceCheck,
  startSourceCheck,
  type SourceCheckState,
} from '@/lib/source-check';

/**
 * Browser checks (Cloudflare) the app runs by itself, one at a time, in the background.
 *
 * At start-up the sources whose saved clearance has run out, or is about to, are queued
 * and passed straight away, so a library update reaches them already cleared instead of
 * failing on the check and leaving their titles stale until the next update. A library
 * update that comes to a queued source moves it to the front and waits for it; one that
 * still meets the check gets it run there and then, and tries the title again.
 *
 * One at a time: each check is a hidden browser window on the source's own site, and
 * several at once would slow every one of them (and the app).
 */

/** A clearance ending sooner than this is renewed at start-up rather than mid-update. */
const RENEW_WITHIN_MS = 60 * 60_000;
/** How long an update waits for a check before going on without it. Past the time a
 * check takes to show its window for a click, which may never come. */
const WAIT_FOR_CHECK_MS = 45_000;

interface Queued {
  sourceId: string;
  done: Promise<SourceCheckState | null>;
  resolve: (state: SourceCheckState | null) => void;
}

const queue: Queued[] = [];
const queued = new Map<string, Queued>();
let working = false;
/** The queued check now running, so a request joining it gets the same promise. */
let current: Queued | null = null;
/** Finding what start-up should check; updates wait for it before asking about a source. */
let startup: Promise<void> | null = null;
let startupFound = false;

export const autoChecksEnabled = () =>
  canCheckSources() && getSetting(AUTO_OPEN_CHALLENGE_SETTING, true) !== false;

async function work(): Promise<void> {
  if (working) return;
  working = true;
  try {
    for (let next = queue.shift(); next; next = queue.shift()) {
      // Out of the waiting list as it starts: from here the running check is what to join,
      // and a request after it ends queues a new one rather than joining a finished one.
      queued.delete(next.sourceId);
      current = next;
      let state: SourceCheckState | null = null;
      try {
        state = await (startSourceCheck(next.sourceId, { auto: true }) ?? null);
      } catch {
        state = getSourceCheck(next.sourceId);
      }
      current = null;
      next.resolve(state);
    }
  } finally {
    working = false;
  }
}

/**
 * Queues the check for a source (or joins the queued or running one). Resolves when it
 * has ended, with how it went; null when it didn't run (not the desktop app, turned off in
 * settings, or failed moments ago).
 */
export function queueSourceCheck(sourceId: string): Promise<SourceCheckState | null> {
  const running = runningSourceCheck(sourceId);
  if (running) return current?.sourceId === sourceId ? current.done : running;
  const existing = queued.get(sourceId);
  if (existing) return existing.done;
  if (!autoChecksEnabled()) return Promise.resolve(null);
  let resolve!: Queued['resolve'];
  const done = new Promise<SourceCheckState | null>((r) => (resolve = r));
  const entry = { sourceId, done, resolve };
  queue.push(entry);
  queued.set(sourceId, entry);
  void work();
  return done;
}

/** Puts a queued source first: something is waiting on it now. */
function moveToFront(sourceId: string): void {
  const index = queue.findIndex((entry) => entry.sourceId === sourceId);
  if (index > 0) queue.unshift(...queue.splice(index, 1));
}

function within<T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(null), ms);
    const onAbort = () => finish(null);
    function finish(value: T | null) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(value);
    }
    if (signal?.aborted) return finish(null);
    signal?.addEventListener('abort', onAbort);
    promise.then(finish, () => finish(null));
  });
}

/**
 * Before a library update checks a source: the wait for that source's check when one is
 * queued or running (start-up's included), moving it to the front. Null, with nothing to
 * wait for, when the source needs none, so its titles start at once.
 */
export function beforeCheckingSource(
  sourceId: string,
  signal?: AbortSignal,
): Promise<SourceCheckState | null> | null {
  if (startup && !startupFound) {
    return within(startup, WAIT_FOR_CHECK_MS, signal).then(() => waitForCheck(sourceId, signal));
  }
  return waitForCheck(sourceId, signal);
}

function waitForCheck(
  sourceId: string,
  signal?: AbortSignal,
): Promise<SourceCheckState | null> | null {
  const running = runningSourceCheck(sourceId);
  if (running) return within(running, WAIT_FOR_CHECK_MS, signal);
  const entry = queued.get(sourceId);
  if (!entry) return null;
  moveToFront(sourceId);
  return within(entry.done, WAIT_FOR_CHECK_MS, signal);
}

/**
 * When a title's update met the check anyway: passes it (or joins the run) and says
 * whether to try the title again.
 */
export async function passCheckForUpdate(sourceId: string, signal?: AbortSignal): Promise<boolean> {
  if (!autoChecksEnabled()) return false;
  const queuedCheck = queueSourceCheck(sourceId);
  moveToFront(sourceId);
  const state = await within(queuedCheck, WAIT_FOR_CHECK_MS, signal);
  return state?.status === 'passed';
}

/** Whether a saved session's clearance has run out or soon will. */
export function clearanceRunningOut(
  cookies: readonly { name: string; expires: number | null }[],
  now = Date.now(),
): boolean {
  const clearance = cookies.filter((cookie) => cookie.name.toLowerCase() === 'cf_clearance');
  if (clearance.length === 0) return false;
  return clearance.every(
    (cookie) => cookie.expires !== null && cookie.expires * 1000 - now < RENEW_WITHIN_MS,
  );
}

/**
 * Whether the source turns the app away with its check now: one small catalogue request.
 * Only for sources that have needed a check before, and one at a time.
 */
export async function asksForCheck(sourceId: string): Promise<boolean> {
  try {
    await getSourceMangaPage(sourceId, { category: 'popular', limit: 1 });
    return false;
  } catch (error) {
    return error instanceof ApiError && error.code === CHALLENGE_REQUIRED;
  }
}

/**
 * The sources start-up should pass the check for: ones whose saved Cloudflare clearance has
 * run out or soon will, and ones this server has seen asking for the check since it
 * started. A source with a saved session that looks current is asked once whether it
 * still lets the app in: the clearance's expiry date is the site's guess, and Cloudflare
 * stops honouring it early when, say, the network's address has changed.
 */
export async function sourcesNeedingCheck(
  probe: (sourceId: string) => Promise<boolean> = asksForCheck,
): Promise<string[]> {
  const [sources, health] = await Promise.all([getSources(), getSourceHealth().catch(() => [])]);
  const challenged = new Set(
    health
      .filter((entry) =>
        [entry.browse, entry.update].some((op) => op?.lastErrorCode === CHALLENGE_REQUIRED),
      )
      .map((entry) => entry.sourceId),
  );
  const extensions = sources.filter((source) => source.provider !== 'suwayomi');
  const sessions = await Promise.all(
    extensions.map((source) =>
      getSourceBrowserSession(source.id).then(
        (session) => [source.id, session] as const,
        () => null,
      ),
    ),
  );
  const saved = sessions.filter(
    (entry): entry is NonNullable<typeof entry> => entry !== null && entry[1].cookies.length > 0,
  );
  const expiring = saved
    .filter(([, session]) => clearanceRunningOut(session.cookies))
    .map(([id]) => id);
  const installed = new Set(extensions.map((source) => source.id));
  const known = new Set([...expiring, ...[...challenged].filter((id) => installed.has(id))]);
  const turnedAway: string[] = [];
  for (const [id] of saved) {
    if (!known.has(id) && (await probe(id))) turnedAway.push(id);
  }
  return [...known, ...turnedAway];
}

/** Queues start-up's checks, once per app start. */
export function checkSourcesOnStartup(
  report: (check: Promise<SourceCheckState | null>) => void = () => undefined,
  find: () => Promise<string[]> = sourcesNeedingCheck,
): Promise<void> {
  if (!autoChecksEnabled()) return Promise.resolve();
  startup ??= find()
    .then((ids) => {
      for (const id of ids) report(queueSourceCheck(id));
      startupFound = true;
    })
    // Quiet: a source that can't be listed is checked when it asks.
    .catch(() => {
      startupFound = true;
    });
  return startup;
}

/** For tests. */
export function resetSourceCheckQueue(): void {
  queue.length = 0;
  queued.clear();
  working = false;
  current = null;
  startup = null;
  startupFound = false;
}
