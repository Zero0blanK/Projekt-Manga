import { request } from './client.js';
import type { CacheSyncResult, CacheStatus } from '@projekt-manga/types';
export type { CacheSyncResult, CacheStatus } from '@projekt-manga/types';

// Sends source_thumbnail_url (snake_case) — the canonical field. cache.controller.ts also
export const triggerCacheSync = (
  mangaId: string,
  sourceThumbnailUrl?: string,
  signal?: AbortSignal,
) =>
  request<CacheSyncResult>(`/cache/sync/${encodeURIComponent(mangaId)}`, {
    method: 'POST',
    body: { source_thumbnail_url: sourceThumbnailUrl },
    signal,
  });

export const getCacheStatus = (mangaId: string, signal?: AbortSignal) =>
  request<CacheStatus>(`/cache/status/${encodeURIComponent(mangaId)}`, { signal });
