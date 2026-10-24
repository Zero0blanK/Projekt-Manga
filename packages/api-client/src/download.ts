import { request, buildApiUrl } from './client.js';

export interface InitiateDownloadChapter {
  id: string;
  name?: string;
  chapter_number: number;
}

export interface InitiateDownloadInput {
  sourceId: string;
  mangaSlug: string;
  mangaTitle: string;
  chapter: InitiateDownloadChapter;
  downloadPath?: string;
}

export interface InitiateDownloadResult {
  id: string;
  status: string;
  progress: number;
  message: string;
}

export interface DownloadStatusResponse {
  id: string;
  status: string;
  mangaTitle: string;
  chapterTitle: string;
  filePath: string;
  completedAt: string | null;
}

export interface DownloadSummary {
  id: string;
  manga_id: string;
  chapter_id: string;
  source_id: string;
  mangaSlug: string;
  status: string;
  mangaTitle: string;
  chapterTitle: string;
  chapterNumber: number;
  pages_total: number;
  pages_downloaded: number;
  current_page: number;
  filePath: string;
  downloaded_path: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface DownloadStats {
  total: number;
  completed: number;
  inProgress: number;
  failed: number;
  totalSize: number;
  storageLimit: number;
  freeBytes: number | null;
}

export interface OrphanedDownloadFolder {
  id: string;
  title: string;
  chapterFolder: string;
  pageCount: number;
  sizeBytes: number;
  modifiedAt: string;
}

export interface DownloadedPage {
  index: number;
  retryable: boolean;
}

export const initiateDownload = (input: InitiateDownloadInput, signal?: AbortSignal) =>
  request<InitiateDownloadResult>('/downloads/chapter', { method: 'POST', body: input, signal });

export const getDownloadStatus = (downloadId: string, signal?: AbortSignal) =>
  request<DownloadStatusResponse>(`/downloads/${encodeURIComponent(downloadId)}`, { signal });

export const getAllDownloads = (signal?: AbortSignal) =>
  request<DownloadSummary[]>('/downloads', { signal });

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

// ─── Live progress (SSE) ─────────────────────────────────────────────────────

export interface DownloadWorkerStatus {
  queueLength: number;
  activeDownloads: number;
  pausedDownloads: number;
  maxConcurrent: number;
  threadCount: number;
}

export interface DownloadProgressEvent {
  downloadId: string;
  currentPage: number;
  totalPages: number;
  pagesDownloaded: number;
}

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
