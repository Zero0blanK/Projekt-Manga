'use client';

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { fetchSourceMangaUpdates } from '@projekt-manga/api-client';
import { invalidateRecentChapters } from '@/lib/notifications-store';
import { getSetting } from '@/lib/app-store';

/**
 * Per-title chapter checks — the same source scrape Update Library runs, but for one
 * manga, so a title can be brought up to date without walking the whole library.
 *
 * State is module-level and keyed by manga id: the detail page's action bar starts the
 * check while the chapter list watches for the result, and they're siblings with no
 * common client parent to hold it.
 */

export type UpdateCheck = {
  checking: boolean;
  /** When the last check finished, or null if none has this session. */
  checkedAt: number | null;
  /** Chapters found by the last check, or null before one has run. */
  found: number | null;
  error: boolean;
  /** Bumped whenever a check actually brings in chapters, so the chapter list knows to
   * re-read from the database rather than polling for a change that usually isn't there. */
  version: number;
};

const IDLE: UpdateCheck = {
  checking: false,
  checkedAt: null,
  found: null,
  error: false,
  version: 0,
};

/** How long a completed check stands before an unforced one is allowed. Nothing fires
 * automatically except a reload, so this mostly guards the double-invoked effect in
 * development and a mashed refresh button. The button passes `force` and ignores it. */
const COOLDOWN_MS = 60_000;

const state = new Map<string, UpdateCheck>();
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((l) => l());

function get(mangaId: string): UpdateCheck {
  return state.get(mangaId) ?? IDLE;
}

function set(mangaId: string, patch: Partial<UpdateCheck>) {
  state.set(mangaId, { ...get(mangaId), ...patch });
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export type UpdatableManga = { id: string; slug: string; source: string };

/**
 * Runs the check. Resolves to the number of new chapters.
 *
 * A source failure is logged by the server and flagged in the response, so a zero
 * result alone does not mean a check succeeded.
 */
export async function checkMangaUpdates(
  manga: UpdatableManga,
  options?: { force?: boolean },
): Promise<number> {
  const current = get(manga.id);
  if (current.checking) return current.found ?? 0;
  if (
    !options?.force &&
    current.checkedAt !== null &&
    Date.now() - current.checkedAt < COOLDOWN_MS
  ) {
    return current.found ?? 0;
  }

  set(manga.id, { checking: true, error: false });
  try {
    const result = await fetchSourceMangaUpdates(manga.source, manga.slug, manga.id);
    if (result.failed) {
      const found = result.newChapters ?? 0;
      set(manga.id, {
        checking: false,
        checkedAt: Date.now(),
        found,
        error: true,
        version: get(manga.id).version + (found > 0 ? 1 : 0),
      });
      if (found > 0) invalidateRecentChapters();
      return found;
    }
    const found = result.newChapters ?? 0;
    set(manga.id, {
      checking: false,
      checkedAt: Date.now(),
      found,
      error: false,
      // Only bump when something actually arrived; a no-op check shouldn't cost the
      // chapter list a re-read.
      version: get(manga.id).version + (found > 0 ? 1 : 0),
    });
    if (found > 0) invalidateRecentChapters();
    return found;
  } catch {
    set(manga.id, { checking: false, checkedAt: Date.now(), found: null, error: true });
    return 0;
  }
}

export function useMangaUpdateCheck(manga: UpdatableManga) {
  const snapshot = useSyncExternalStore(
    subscribe,
    () => get(manga.id),
    () => IDLE,
  );

  const check = useCallback(
    (options?: { force?: boolean }) => checkMangaUpdates(manga, options),
    [manga.id, manga.slug, manga.source], // eslint-disable-line react-hooks/exhaustive-deps
  );

  return { ...snapshot, check };
}

/**
 * The reload check for a path, once per document.
 *
 * Keyed by path and holding the promise rather than a "done" flag, because the effect
 * below is invoked twice in development: React mounts, cleans up, and mounts again. A
 * one-shot flag would be consumed by the first pass — whose result is discarded as
 * stale — leaving the second pass to skip the check, so the scrape would run but never be
 * reported. Sharing the promise lets whichever pass survives report.
 */
const reloadChecks = new Map<string, { promise: Promise<number>; reported: boolean }>();

/**
 * True when the current document was produced by the reader reloading *this* page.
 *
 * `PerformanceNavigationTiming.type` distinguishes a reload from an ordinary navigation,
 * but it describes the document, not the route: after reloading elsewhere and then
 * navigating here client-side the entry still reads "reload". Comparing the entry's own
 * URL against the current path is what makes it mean "you reloaded this page".
 *
 * Pure — it only answers the question. Whether the check has already run is `reloadChecks`.
 */
function isManualReloadOf(pathname: string): boolean {
  if (typeof window === 'undefined') return false;
  const [entry] = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
  if (!entry || entry.type !== 'reload') return false;
  try {
    return new URL(entry.name).pathname === pathname;
  } catch {
    return false;
  }
}

/**
 * Checks for new chapters when the reader reloads the title's page — and only then.
 *
 * Deliberately not on every mount: opening a title from the library is a navigation, not a
 * request to re-scrape the source, and firing there would make ordinary browsing a live
 * request per title. A reload is an explicit "get me the current state of this", which is
 * the signal worth acting on.
 *
 * `onResult` fires once, when the check settles. A scrape takes seconds and usually
 * changes nothing visible, so without it the whole thing is indistinguishable from the
 * reload having done nothing — the caller is expected to say something either way.
 */
export function useCheckOnManualReload(
  manga: UpdatableManga,
  options?: { enabled?: boolean; onResult?: (found: number, error: boolean) => void },
) {
  const enabled = options?.enabled ?? true;
  const onResult = options?.onResult;
  // Held in a ref so a caller passing an inline arrow doesn't re-run the effect — and
  // re-running it would mean a second scrape.
  const report = useRef(onResult);
  report.current = onResult;

  useEffect(() => {
    if (!enabled) return;
    if (getSetting('checkChaptersOnReload', true) !== true) return;

    const path = window.location.pathname;
    if (!isManualReloadOf(path)) return;

    let entry = reloadChecks.get(path);
    if (!entry) {
      entry = { promise: checkMangaUpdates(manga, { force: true }), reported: false };
      reloadChecks.set(path, entry);
    }

    let cancelled = false;
    void entry.promise.then((found) => {
      const current = reloadChecks.get(path);
      if (cancelled || !current || current.reported) return;
      current.reported = true;
      report.current?.(found, get(manga.id).error);
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, manga.id, manga.slug, manga.source]);
}

/** Increments when a check brings in new chapters for this title. */
export function useChapterListVersion(mangaId: string): number {
  return useSyncExternalStore(
    subscribe,
    () => get(mangaId).version,
    () => 0,
  );
}
