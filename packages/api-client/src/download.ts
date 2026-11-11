import { fetchAllPages, request, buildApiUrl } from './client.js';
import type {
  InitiateDownloadChapter,
  InitiateDownloadInput,
  InitiateDownloadResult,
  DownloadStatusResponse,
  DownloadSummary,
  DownloadStats,
  OrphanedDownloadFolder,
  DownloadedPage,
  DownloadWorkerStatus,
  DownloadProgressEvent,
  DownloadRestoreScan,
  DownloadRestoreResult,
} from '@projekt-manga/types';
export type {
  InitiateDownloadChapter,
  InitiateDownloadInput,
  InitiateDownloadResult,
  DownloadStatusResponse,
  DownloadSummary,
  DownloadStats,
  OrphanedDownloadFolder,
  DownloadedPage,
  DownloadWorkerStatus,
  DownloadProgressEvent,
  DownloadRestoreScan,
  DownloadRestoreResult,
  RestorableTitle,
  RestorableTitleStatus,
} from '@projekt-manga/types';

export const initiateDownload = (input: InitiateDownloadInput, signal?: AbortSignal) =>
  request<InitiateDownloadResult>('/downloads/chapter', { method: 'POST', body: input, signal });

export const getDownloadStatus = (downloadId: string, signal?: AbortSignal) =>
  request<DownloadStatusResponse>(`/downloads/${encodeURIComponent(downloadId)}`, { signal });

export const getAllDownloads = (signal?: AbortSignal) =>
  fetchAllPages((page) => request<DownloadSummary[]>('/downloads', { signal, query: page }));

export const getDownloadDirectory = (signal?: AbortSignal) =>
  request<{ path: string }>('/downloads/directory', { signal });

export const setDownloadDirectory = (path?: string) =>
  request<{ path: string }>('/downloads/directory', { method: 'PATCH', body: { path } });

export const resetDownloadDirectory = () =>
  request<{ path: string }>('/downloads/directory', { method: 'PATCH', body: { path: '' } });

export const cancelDownload = (downloadId: string) =>
  request<{ id: string }>(`/downloads/${encodeURIComponent(downloadId)}`, { method: 'DELETE' });

export const pauseDownload = (downloadId: string) =>
  request<{ id: string }>(`/downloads/${encodeURIComponent(downloadId)}/pause`, {
    method: 'PATCH',
  });

export const resumeDownload = (downloadId: string) =>
  request<{ id: string }>(`/downloads/${encodeURIComponent(downloadId)}/resume`, {
    method: 'PATCH',
  });

export const getDownloadStats = (signal?: AbortSignal) =>
  request<DownloadStats>('/downloads/stats', { signal });

export const setDownloadStorageLimit = (bytes: number) =>
  request<{ bytes: number }>('/downloads/storage-limit', { method: 'PATCH', body: { bytes } });

export const getOrphanedDownloadFolders = (signal?: AbortSignal) =>
  request<OrphanedDownloadFolder[]>('/downloads/orphans', { signal });

export const cleanupOrphanedDownloadFolders = (ids: string[]) =>
  request<{ removed: number; freedBytes: number }>('/downloads/orphans/cleanup', {
    method: 'POST',
    body: { ids },
  });

/** Looks for downloads the app has no record of, in `root` or in the folders it knows. */
export const scanForDownloadsToRestore = (root?: string, signal?: AbortSignal) =>
  request<DownloadRestoreScan>('/downloads/restore/scan', {
    signal,
    query: root ? { root } : undefined,
  });

export const restoreDownloads = (titles: string[], root?: string) =>
  request<DownloadRestoreResult>('/downloads/restore', {
    method: 'POST',
    body: { titles, ...(root ? { root } : {}) },
  });

export const isChapterDownloaded = (chapterId: string, signal?: AbortSignal) =>
  request<{ isDownloaded: boolean }>(`/downloads/chapter/${encodeURIComponent(chapterId)}/check`, {
    signal,
  });

export const getDownloadedChapterPages = (chapterId: string, signal?: AbortSignal) =>
  request<DownloadedPage[]>(`/downloads/chapter/${encodeURIComponent(chapterId)}/pages`, {
    signal,
  });

/** URL for an <img src> — not fetched through request(), the response body is the stored
 * page image itself, not a JSON envelope. `index` is the position in the chapter's page
 * list, matching `DownloadedPage.index`. */
export const buildDownloadedPageUrl = (chapterId: string, index: number) =>
  buildApiUrl(`/downloads/chapter/${encodeURIComponent(chapterId)}/page/${index}`);

/** URL of a downloaded chapter as a CBZ file, for a download link (not fetched through
 * request(): the body is the archive itself). */
export const downloadedChapterCbzUrl = (chapterId: string) =>
  buildApiUrl(`/downloads/chapter/${encodeURIComponent(chapterId)}/cbz`);

// ─── Live progress (SSE) ─────────────────────────────────────────────────────

export interface DownloadEventHandlers {
  onConnected?: (status: DownloadWorkerStatus) => void;
  onProgress?: (event: DownloadProgressEvent) => void;
  onComplete?: (downloadId: string) => void;
  onFailed?: (downloadId: string) => void;
  onError?: (error: Event) => void;
}

/** Subscribes to the server's download progress stream. Returns an unsubscribe function.
 * Browser-only (relies on the global EventSource). */
export function subscribeToDownloadEvents(handlers: DownloadEventHandlers): () => void {
  const source = new EventSource(buildApiUrl('/downloads/events'));

  const listen = <T>(event: string, handler?: (payload: T) => void) => {
    if (!handler) return;
    source.addEventListener(event, (e) => {
      // Frame data is external input arriving on a long-lived connection: a truncated or
      // malformed payload (proxy buffering, a server-side serialization bug) would throw
      // here, and a throw inside an EventSource listener is unhandled — it surfaces as a
      // console error and takes down that frame's handling rather than being skipped.
      // Drop the bad frame; the stream keeps running and the next one is fine.
      let payload: T;
      try {
        payload = JSON.parse((e as MessageEvent).data) as T;
      } catch {
        return;
      }
      if (payload === null || payload === undefined) return;
      handler(payload);
    });
  };

  listen<DownloadWorkerStatus>('connected', handlers.onConnected);
  listen<DownloadProgressEvent>('progress', handlers.onProgress);
  listen<{ downloadId?: string }>('complete', (payload) => {
    if (typeof payload.downloadId === 'string') handlers.onComplete?.(payload.downloadId);
  });
  listen<{ downloadId?: string }>('failed', (payload) => {
    if (typeof payload.downloadId === 'string') handlers.onFailed?.(payload.downloadId);
  });

  if (handlers.onError) {
    source.addEventListener('error', handlers.onError);
  }

  return () => source.close();
}
