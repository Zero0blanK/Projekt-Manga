import { request } from './client.js';

export interface CacheSyncResult {
  updated: boolean;
  hostedUrl?: string;
}

export interface CacheStatus {
  exists: boolean;
  manga_id: string;
  thumbnail_url: string;
  sha256_url: string;
}

// Sends source_thumbnail_url (snake_case) — the canonical field. cache.controller.ts also
// accepts a sourceThumbnailUrl camelCase alias for an older caller; new code shouldn't need it.
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
