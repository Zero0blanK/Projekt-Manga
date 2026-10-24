'use client';

import { useSyncExternalStore } from 'react';
import { fetchSourceMangaUpdates, triggerCacheSync } from '@projekt-manga/api-client';
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

async function performLibraryUpdate(
  manga: Manga[],
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
  const failedBySource: Record<string, number> = {};
  const startedSources = new Set<string>();
  let cancelled = false;

  for (let i = 0; i < manga.length; i++) {
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
        // Make the notification feed reflect each completed source call immediately.
        invalidateRecentChapters();
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
  return { found, failed, foundBySource, failedBySource, cancelled };
}
