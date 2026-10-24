'use client';

import { useEffect, useSyncExternalStore } from 'react';
import {
  getAllDownloads,
  subscribeToDownloadEvents,
  type DownloadSummary,
} from '@projekt-manga/api-client';
import { useMangaLibrary } from '@/lib/library-store';
import { getSetting } from '@/lib/app-store';
import { toast } from '@/hooks/use-toast';

export type DownloadRowStatus = 'queued' | 'downloading' | 'paused' | 'done' | 'failed';

export type DownloadRow = {
  id: string;
  mangaId: string;
  sourceId?: string;
  title: string;
  /** Real cover art, resolved from the library by manga id. Null when the title is no
   * longer in the library, in which case the row shows a neutral placeholder. */
  thumbnailUrl: string | null;
  chapters: string;
  chapterNumber: number;
  /** Where the chapter was written on disk, once the download has produced files. */
  folderPath: string | null;
  pages: string;
  status: DownloadRowStatus;
  progress: number;
  addedAt: string;
};

const STATUS_MAP: Record<string, DownloadRowStatus> = {
  PENDING: 'queued',
  IN_PROGRESS: 'downloading',
  PAUSED: 'paused',
  COMPLETED: 'done',
  FAILED: 'failed',
};

function toRow(d: DownloadSummary): DownloadRow {
  // A completed DB record with no allowed existing chapter directory is stale. Present
  // it with failed downloads so the explicit cleanup action can remove the orphaned row.
  const status =
    d.status === 'COMPLETED' && !d.downloaded_path ? 'failed' : (STATUS_MAP[d.status] ?? 'queued');
  return {
    id: d.id,
    mangaId: d.manga_id,
    sourceId: d.source_id,
    title: d.mangaTitle,
    thumbnailUrl: null,
    chapters: `Chapter ${d.chapterNumber}`,
    chapterNumber: d.chapterNumber,
    folderPath: d.downloaded_path || d.filePath || null,
    pages:
      status === 'done'
        ? `${d.pages_total} pages`
        : `${d.pages_downloaded} / ${d.pages_total} pages`,
    status,
    progress: d.pages_total > 0 ? d.pages_downloaded / d.pages_total : 0,
    addedAt: d.createdAt,
  };
}

/**
 * One shared download store for the whole app.
 *
 * Module-level rather than per-hook: the nav badge and the downloads page are mounted
 * together, and separate stores would each open an EventSource and announce the same
 * "Download finished" toast twice. The SSE subscription is opened when the first consumer
 * mounts and closed when the last unmounts.
 */
let rows: DownloadRow[] = [];
let loading = true;
let error = false;
let refreshId = 0;
const listeners = new Set<() => void>();
let unsubscribeEvents: (() => void) | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

/** The download stream reports progress, completion and failure — but nothing for a
 * download merely being *queued*. A slow poll alongside it catches queue additions made
 * from another tab or directly against the API. */
const POLL_INTERVAL_MS = 20_000;

const emit = () => listeners.forEach((l) => l());

function setRows(next: DownloadRow[]) {
  rows = next;
  emit();
}

function refresh() {
  const id = ++refreshId;
  getAllDownloads()
    .then((all) => {
      if (id !== refreshId) return;
      loading = false;
      error = false;
      setRows(all.map(toRow));
    })
    .catch(() => {
      if (id !== refreshId) return;
      loading = false;
      error = true;
      emit();
    });
}

function startPolling() {
  if (pollTimer !== null) return;
  pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible') refresh();
  }, POLL_INTERVAL_MS);
}

function onVisibilityChange() {
  if (document.visibilityState === 'visible') refresh();
}

function connect() {
  if (unsubscribeEvents) return;
  refresh();
  startPolling();
  document.addEventListener('visibilitychange', onVisibilityChange);
  unsubscribeEvents = subscribeToDownloadEvents({
    onProgress: (event) => {
      setRows(
        rows.map((r) =>
          r.id === event.downloadId
            ? {
                ...r,
                status: 'downloading',
                progress: event.totalPages > 0 ? event.pagesDownloaded / event.totalPages : 0,
                pages: `${event.pagesDownloaded} / ${event.totalPages} pages`,
              }
            : r,
        ),
      );
    },
    onComplete: (downloadId) => {
      // Settings > Notifications > Download finished. Read at fire time rather than
      // captured, so toggling it mid-download takes effect immediately.
      if (getSetting('notifyDownloadComplete', true) === true) {
        const row = rows.find((r) => r.id === downloadId);
        toast({
          title: 'Download finished',
          description: row ? `${row.title} · ${row.chapters}` : 'A chapter is available offline.',
        });
      }
      refresh();
    },
    onFailed: () => {
      refresh();
    },
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) connect();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      unsubscribeEvents?.();
      unsubscribeEvents = null;
      if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
  };
}

const EMPTY: DownloadRow[] = [];

function useRawRows() {
  const data = useSyncExternalStore(
    subscribe,
    () => rows,
    () => EMPTY,
  );
  const isLoading = useSyncExternalStore(
    subscribe,
    () => loading,
    () => true,
  );
  const hasError = useSyncExternalStore(
    subscribe,
    () => error,
    () => false,
  );
  return { data, loading: isLoading, error: hasError };
}

/** Just the number of downloads still needing to finish — for the nav badge, which
 * doesn't need cover art or the library join. */
export function useDownloadQueueCount(): number {
  const { data } = useRawRows();
  return data.filter((r) => r.status !== 'done' && r.status !== 'failed').length;
}

export function useDownloadRows() {
  const { data, loading: isLoading, error: hasError } = useRawRows();
  // Downloads don't carry cover art themselves — resolve it from the library by manga id.
  const { manga: library } = useMangaLibrary();

  const withCovers = data.map((r) => {
    const match = library.find((m) => m.id === r.mangaId);
    return match ? { ...r, thumbnailUrl: match.thumbnailUrl } : r;
  });

  return {
    // Failed downloads land here too — they still need a user action (remove/retry),
    // unlike completed ones which are just sitting there ready to read.
    active: withCovers.filter((r) => r.status !== 'done'),
    completed: withCovers.filter((r) => r.status === 'done'),
    loading: isLoading,
    error: hasError,
    refresh,
  };
}

/** Re-reads the download list — for callers that changed it through another path
 * (cancel, pause, remove) and can't wait for the next server event. */
export function refreshDownloads() {
  refresh();
}

/** Keeps the store connected for as long as the component is mounted, without reading
 * any of it. Used by the nav so the badge is live on every page. */
export function useDownloadsConnection() {
  useEffect(() => subscribe(() => {}), []);
}
