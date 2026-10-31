import { request } from './client.js';
import type {
  BackupConfig,
  BackupFileInfo,
  BackupStatus,
  ReadingDataExport,
} from '@projekt-manga/types';
import type { UpdateBackupConfigBody } from '@projekt-manga/schemas';

/** Building an export reads every title's chapters, which can outlast the default deadline
 * on a large library. */
const EXPORT_TIMEOUT_MS = 5 * 60_000;

/** `owner` guards against the session changing between the click and the response, the
 * same check restore job polling uses. */
export const exportReadingDataFromServer = (owner: string, signal?: AbortSignal) =>
  request<ReadingDataExport>('/backup/export', {
    query: { owner },
    signal,
    cache: 'no-store',
    timeoutMs: EXPORT_TIMEOUT_MS,
  });

export const getBackupStatus = (owner: string, signal?: AbortSignal) =>
  request<BackupStatus>('/backup', { query: { owner }, signal, cache: 'no-store' });

export const createBackupNow = (owner: string) =>
  request<BackupFileInfo>('/backup', {
    method: 'POST',
    query: { owner },
    timeoutMs: EXPORT_TIMEOUT_MS,
  });

export const getBackupFile = (name: string, owner: string, signal?: AbortSignal) =>
  request<ReadingDataExport>(`/backup/files/${encodeURIComponent(name)}`, {
    query: { owner },
    signal,
    cache: 'no-store',
  });

export const updateBackupConfig = (patch: UpdateBackupConfigBody) =>
  request<BackupConfig>('/backup/config', { method: 'PATCH', body: patch });
