import { request } from './client.js';
import type { SyncPushBody } from '@projekt-manga/schemas';
import type { SyncPullResult, DomainPushResult, SyncPushResult } from '@projekt-manga/types';
export type { SyncPullResult, DomainPushResult, SyncPushResult } from '@projekt-manga/types';

/** `since` omitted pulls everything — used for a device's very first sync. */
export const syncPull = (since?: string, signal?: AbortSignal) =>
  request<SyncPullResult>('/sync/pull', { query: { since }, signal });

export const syncPush = (body: SyncPushBody) =>
  request<SyncPushResult>('/sync/push', { method: 'POST', body });
