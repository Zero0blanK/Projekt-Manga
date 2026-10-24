import type { MangaHistory } from '@projekt-manga/types';
import { request } from './client.js';
import { hasLocalDataBridge, localInvoke } from './runtime.js';

/** Row shape returned by GET /history (flattened, with manga title/thumbnail resolved). */
export interface HistoryEntry {
  id: string;
  source: string;
  manga_id?: string;
  /** Whether this title is in the current account's library (or the anonymous library). */
  in_library?: boolean;
  manga_slug: string;
  source_manga_id?: string;
  chapter_id?: string;
  pages_read: number;
  time_read: number;
  last_read: string;
  read_at: string;
  title?: string;
  thumbnail_url?: string;
  chapter_number?: number;
  name?: string;
  is_read?: boolean;
  last_page_read: number;
  page_count: number;
}

export interface HistoryRecord {
  id: string;
  source: string;
  manga_id: string | null;
  manga_slug: string;
  source_manga_id?: string | null;
  chapter_id: string | null;
  thumbnail_url: string | null;
  read_at: string;
  last_read: string;
  pages_read: number;
  time_read: number;
}

export interface HistoryByMangaSlugEntry extends HistoryRecord {
  chapter: {
    id: string;
    chapter_number: number;
    name: string | null;
    is_read: boolean;
    last_page_read: number;
    page_count: number | null;
  } | null;
}

/** HTTP-only history for the current server session, including on desktop. */
export const getServerHistory = (signal?: AbortSignal) =>
  request<HistoryEntry[]>('/history', { signal });

export const getHistory = (signal?: AbortSignal) => {
  if (hasLocalDataBridge()) {
    // localInvoke has no AbortSignal parameter — `signal` is silently dropped on this
    // branch, so cancellation is only honoured on the HTTP path below. A caller relying on
    // abort here keeps waiting on desktop.
    return localInvoke<HistoryEntry[]>('history', 'list');
  }
  return getServerHistory(signal);
};

export const addHistory = (historyData: MangaHistory) => {
  if (hasLocalDataBridge()) {
    return localInvoke<HistoryRecord>('history', 'add', historyData);
  }
  return request<HistoryRecord>('/history/add', { method: 'POST', body: historyData });
};

export const getHistoryByMangaSlug = (mangaSlug: string, signal?: AbortSignal, source?: string) =>
  request<HistoryByMangaSlugEntry[]>(`/history/${encodeURIComponent(mangaSlug)}`, {
    signal,
    query: { source },
  });

export const deleteHistory = async (id: string) => {
  const result = await request<null>(`/history/delete/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (hasLocalDataBridge()) await localInvoke('history', 'delete', { id });
  return result;
};
