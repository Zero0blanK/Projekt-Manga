'use client';

import { useSyncExternalStore } from 'react';
import { autoDownloadNewChapters } from '@/lib/auto-downloads';
import {
  fetchSourceMangaUpdates,
  getAllMangaLinks,
  triggerCacheSync,
} from '@projekt-manga/api-client';
import type { Manga } from '@/lib/manga-data';
import { invalidateRecentChapters } from '@/lib/notifications-store';

export type LibraryUpdateProgress = {
  done: number;
  total: number;
  found: number;
  title: string;
};

export type LibraryUpdateResult = {
  found: number;
  failed: string[];
  foundBySource: Record<string, number>;
  /** New chapters per library entry id, so notifications can honour muted categories. */
  foundByManga: Record<string, number>;
  /** The titles named in foundByManga, linked sources included (they aren't in the
   * library list the caller holds). */
  foundTitles: Record<string, string>;
  failedBySource: Record<string, number>;
  cancelled: boolean;
};

let activeRun: { promise: Promise<LibraryUpdateResult>; controller: AbortController } | null = null;
let progress: LibraryUpdateProgress | null = null;
const listeners = new Set<() => void>();

function setProgress(next: LibraryUpdateProgress | null): void {
  progress = next;
  listeners.forEach((listener) => listener());
}

export function isLibraryUpdateRunning(): boolean {
  return activeRun !== null;
}

/** Stop the shared run when the active account changes or its owning app shell unmounts. */
export function cancelLibraryUpdate(): void {
  activeRun?.controller.abort();
}

export function useLibraryUpdateProgress(): LibraryUpdateProgress | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => progress,
    () => null,
  );
}

/**
 * Runs one serialized pass over an already-filtered library. Both the manual control and
 * the automatic timer use this so the latter cannot accidentally scrape sources in a
 * different order or with different cover-refresh behavior.
 */
export async function runLibraryUpdate(
  manga: Manga[],
  options: {
    refreshCovers: boolean;
    onProgress?: (progress: LibraryUpdateProgress) => void;
    onSourceStart?: (source: string) => void;
  },
): Promise<LibraryUpdateResult> {
  if (activeRun) return activeRun.promise;

  const controller = new AbortController();
  const run = performLibraryUpdate(manga, options, controller.signal);
  activeRun = { promise: run, controller };
  try {
    return await run;
  } finally {
    if (activeRun?.promise === run) activeRun = null;
    setProgress(null);
  }
}

/**
 * The linked sources (other sources' copies) of the titles being checked, so chapters only
 * a linked source has arrive with the update: linked titles are outside the library, so
 * nothing else would check them. Looked up while the titles themselves are checked; a
 * failed lookup checks the titles alone.
 */
async function linkedSourcesOf(manga: Manga[], signal: AbortSignal): Promise<Manga[]> {
  let groups: Awaited<ReturnType<typeof getAllMangaLinks>>;
  try {
    groups = await getAllMangaLinks(signal);
  } catch {
    return [];
  }
  const linkedOf = new Map(groups.map((group) => [group.primary_id, group.linked]));
  const seen = new Set(manga.map((entry) => entry.id));
  return manga.flatMap((entry) =>
    (linkedOf.get(entry.id) ?? [])
      .filter((linked) => !seen.has(linked.id) && seen.add(linked.id))
      .map(
        (linked) =>
          ({
            id: linked.id,
            title: linked.title,
            source: linked.source,
            slug: linked.slug,
          }) as Manga,
      ),
  );
}

async function performLibraryUpdate(
  requested: Manga[],
  options: {
    refreshCovers: boolean;
    onProgress?: (progress: LibraryUpdateProgress) => void;
    onSourceStart?: (source: string) => void;
  },
  signal: AbortSignal,
): Promise<LibraryUpdateResult> {
  let found = 0;
  const failed: string[] = [];
  const foundBySource: Record<string, number> = {};
  const foundByManga: Record<string, number> = {};
  const foundTitles: Record<string, string> = {};
  const failedBySource: Record<string, number> = {};
  const startedSources = new Set<string>();
  let cancelled = false;
  const manga = [...requested];
  const linkedPromise = linkedSourcesOf(requested, signal);
  let linkedAppended = false;

  for (let i = 0; ; i++) {
    // Linked titles go last, so the library's own titles start at once.
    if (i >= manga.length) {
      if (linkedAppended || signal.aborted) break;
      linkedAppended = true;
      manga.push(...(await linkedPromise));
      if (i >= manga.length) break;
    }
    if (signal.aborted) {
      cancelled = true;
      break;
    }
    const entry = manga[i];
    const nextProgress = { done: i, total: manga.length, found, title: entry.title };
    setProgress(nextProgress);
    options.onProgress?.(nextProgress);
    try {
      if (!startedSources.has(entry.source)) {
        startedSources.add(entry.source);
        options.onSourceStart?.(entry.source);
      }
      const result = await fetchSourceMangaUpdates(entry.source, entry.slug, entry.id, signal);
      if (signal.aborted) {
        cancelled = true;
        break;
      }
      if (result.newChapters > 0) {
        found += result.newChapters;
        foundBySource[entry.source] = (foundBySource[entry.source] ?? 0) + result.newChapters;
        foundByManga[entry.id] = (foundByManga[entry.id] ?? 0) + result.newChapters;
        foundTitles[entry.id] = entry.title;
        // Make the notification feed reflect each completed source call immediately.
        invalidateRecentChapters();
      }
      // Not awaited: queueing downloads must not slow the scan, and a failure to queue
      // (storage limit, full queue) is not a failed update.
      if (result.newChapterList?.length) {
        void autoDownloadNewChapters(entry, result.newChapterList).catch(() => undefined);
      }
      if (result.failed) {
        failed.push(entry.title);
        failedBySource[entry.source] = (failedBySource[entry.source] ?? 0) + 1;
        continue;
      }
      if (options.refreshCovers) {
        await triggerCacheSync(entry.id, undefined, signal).catch(() => undefined);
        if (signal.aborted) {
          cancelled = true;
          break;
        }
      }
    } catch {
      if (signal.aborted) {
        cancelled = true;
        break;
      }
      // A bad source must not stop the remaining sequential, rate-friendly scan.
      failed.push(entry.title);
      failedBySource[entry.source] = (failedBySource[entry.source] ?? 0) + 1;
    }
  }

  if (!cancelled) invalidateRecentChapters();
  return { found, failed, foundBySource, foundByManga, foundTitles, failedBySource, cancelled };
}
