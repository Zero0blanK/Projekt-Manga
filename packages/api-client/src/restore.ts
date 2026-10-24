import { request } from './client.js';
import type { PreviewBackupBody, ReplaceBackupBody } from '@projekt-manga/schemas';

export type RestoreJob = {
  id: string;
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  result: { restoredManga: number; restoredProgress: number; restoredHistory: number } | null;
  progress: { phase: string; completed: number; total: number } | null;
};

export type RestorePreview = {
  matchingTitles: number;
  addedTitles: number;
  importedTitles: number;
  catalogRowsUpdated: number;
  catalogUpdateExamples: string[];
  chapterIdentityConflicts: number;
  chapterIdentityConflictExamples: string[];
  retainedHistory: number;
  addedHistory: number;
};

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
