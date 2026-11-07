import { request } from './client.js';
import type { PreviewBackupBody, ReplaceBackupBody } from '@projekt-manga/schemas';
import type { RestoreJob, RestorePreview } from '@projekt-manga/types';
export type { RestoreJob, RestorePreview } from '@projekt-manga/types';

export const previewRestore = (backup: PreviewBackupBody, signal?: AbortSignal) =>
  request<RestorePreview>('/restore/preview', { method: 'POST', body: backup, signal });

export const startReplaceRestore = (backup: ReplaceBackupBody) =>
  request<Pick<RestoreJob, 'id' | 'state'>>('/restore/jobs', { method: 'POST', body: backup });

export const getReplaceRestore = (id: string, owner: string, signal?: AbortSignal) =>
  request<RestoreJob>(`/restore/jobs/${encodeURIComponent(id)}`, { query: { owner }, signal });

export const cancelReplaceRestore = (id: string, owner: string) =>
  request<RestoreJob>(`/restore/jobs/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    query: { owner },
  });
