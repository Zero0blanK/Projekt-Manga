import { request } from './client.js';
import type { SyncPushBody } from '@projekt-manga/schemas';

export interface SyncPullResult {
  generation: number;
  server_time: string;
  next_since: string;
  has_more: boolean;
  library: {
    id: string;
    user_id: string;
    manga_id: string;
    deleted_at: string | null;
    updated_at: string;
  }[];
  manga_state: {
    id: string;
    user_id: string;
    manga_id: string;
    is_bookmarked: boolean;
    shelf_status: string | null;
    notification_read: boolean;
    updated_at: string;
  }[];
  chapter_state: {
    id: string;
    user_id: string;
    chapter_id: string;
    is_read: boolean;
    is_bookmark: boolean;
    last_page_read: number;
    updated_at: string;
  }[];
  manga_category: {
    id: string;
    user_id: string;
    manga_id: string;
    category_id: string;
    deleted_at: string | null;
    updated_at: string;
  }[];
  history: {
    id: string;
    source: string;
    manga_id: string | null;
    manga_slug: string;
    title: string | null;
    thumbnail_url: string | null;
    chapter_id: string | null;
    read_at: string;
    last_read: string;
    pages_read: number;
    time_read: number;
    deleted_at: string | null;
  }[];
  categories: { id: string; name: string }[];
}

/** `failed` holds the ids of rows that couldn't be applied (e.g. referencing a manga/
 * chapter/category that no longer exists) — one bad row no longer aborts the rest of the
 * batch, so this is how a caller learns something didn't fully land. */
export interface DomainPushResult {
  applied: number;
  failed: string[];
}

export interface SyncPushResult {
  library: DomainPushResult;
  manga_state: DomainPushResult;
  chapter_state: DomainPushResult;
  manga_category: DomainPushResult;
  history: DomainPushResult;
}

/** `since` omitted pulls everything — used for a device's very first sync. */
export const syncPull = (since?: string, signal?: AbortSignal) =>
  request<SyncPullResult>('/sync/pull', { query: { since }, signal });

export const syncPush = (body: SyncPushBody) =>
  request<SyncPushResult>('/sync/push', { method: 'POST', body });
