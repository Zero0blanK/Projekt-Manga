import type { MangaHistory } from '@projekt-manga/types';
import { fetchAllPages, request } from './client.js';
import { awaitProgressWrite } from './progressHold.js';
import { localInvoke, usesLocalFirstData } from './runtime.js';
import type { HistoryEntry, HistoryRecord, HistoryByMangaSlugEntry } from '@projekt-manga/types';
export type { HistoryEntry, HistoryRecord, HistoryByMangaSlugEntry } from '@projekt-manga/types';

/** HTTP-only history for the current server session, including on desktop. */
export const getServerHistory = (signal?: AbortSignal) =>
  fetchAllPages((page) => request<HistoryEntry[]>('/history', { signal, query: page }));

export const getHistory = async (signal?: AbortSignal) => {
  if (await usesLocalFirstData()) {
    // localInvoke has no AbortSignal parameter — `signal` is silently dropped on this
    // branch, so cancellation is only honoured on the HTTP path below. A caller relying on
    // abort here keeps waiting on desktop.
    return localInvoke<HistoryEntry[]>('history', 'list');
  }
  return getServerHistory(signal);
};

export const addHistory = async (historyData: MangaHistory) => {
  if (await usesLocalFirstData()) {
    return localInvoke<HistoryRecord>('history', 'add', historyData);
  }
  const key = `history:${historyData.source}:${historyData.manga_slug}:${historyData.source_chapter_key ?? ''}`;
  if (!(await awaitProgressWrite(key))) return null;
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
  if (await usesLocalFirstData()) await localInvoke('history', 'delete', { id });
  return result;
};
