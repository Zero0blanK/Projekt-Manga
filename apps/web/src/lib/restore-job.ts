'use client';

import { useSyncExternalStore } from 'react';
import { onlineManager } from '@tanstack/react-query';
import {
  ApiError,
  cancelReplaceRestore,
  getReplaceRestore,
  getCurrentUser,
  hasLocalDataBridge,
  localInvoke,
} from '@projekt-manga/api-client';
import { toast } from '@/hooks/use-toast';
import { setState } from './app-store';
import { queryClient, queryKeys } from './query-client';
import { profileSettingsForImport, replaceProfileSettings } from './profile-settings';

const storageKey = 'projekt-manga-pending-restore';
const pendingEvents = [
  'projekt-manga-restore-started',
  'projekt-manga-restore-finished',
  'projekt-manga-restore-progress',
] as const;

export function useRestorePending(): boolean {
  return useSyncExternalStore(
    (listener) => {
      for (const event of pendingEvents) window.addEventListener(event, listener);
      window.addEventListener('storage', listener);
      return () => {
        for (const event of pendingEvents) window.removeEventListener(event, listener);
        window.removeEventListener('storage', listener);
      };
    },
    () => getPendingRestore() !== null,
    () => false,
  );
}

export function acknowledgeRestoreFailure(): void {
  const pending = getPendingRestore();
  if (pending?.failed || pending?.cancelled) clearPendingRestore(pending.id);
}
export type PendingRestore = {
  id: string;
  mode?: 'merge' | 'replace';
  owner: string;
  settings: Record<string, string | number | boolean>;
  skippedDownloads: number;
  startedAt: number;
  failed?: boolean;
  cancelled?: boolean;
  statusUnknown?: boolean;
  progress?: { phase: string; completed: number; total: number } | null;
};

export function savePendingRestore(value: PendingRestore): void {
  if (getPendingRestore())
    throw new Error(
      'A restore is already being tracked in this browser. Wait for it to finish before starting another.',
    );
  localStorage.setItem(storageKey, JSON.stringify(value));
  window.dispatchEvent(new Event('projekt-manga-restore-started'));
}

export function getPendingRestore(): PendingRestore | null {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    const record = value as Partial<PendingRestore>;
    if (typeof record.id !== 'string' || typeof record.owner !== 'string') return null;
    const settings =
      record.settings && typeof record.settings === 'object' && !Array.isArray(record.settings)
        ? Object.fromEntries(
            Object.entries(record.settings).filter(
              ([, value]) =>
                typeof value === 'string' ||
                typeof value === 'boolean' ||
                (typeof value === 'number' && Number.isFinite(value)),
            ),
          )
        : {};
    return {
      id: record.id,
      mode: record.mode === 'merge' ? 'merge' : 'replace',
      owner: record.owner,
      settings,
      skippedDownloads:
        typeof record.skippedDownloads === 'number' &&
        Number.isInteger(record.skippedDownloads) &&
        record.skippedDownloads >= 0
          ? record.skippedDownloads
          : 0,
      startedAt:
        typeof record.startedAt === 'number' && Number.isFinite(record.startedAt)
          ? record.startedAt
          : Date.now(),
      failed: record.failed === true,
      cancelled: record.cancelled === true,
      statusUnknown: record.statusUnknown === true,
      progress:
        record.progress &&
        typeof record.progress.phase === 'string' &&
        Number.isInteger(record.progress.completed) &&
        Number.isInteger(record.progress.total) &&
        record.progress.total >= 0 &&
        record.progress.completed >= 0 &&
        record.progress.completed <= record.progress.total
          ? record.progress
          : null,
    };
  } catch {
    return null;
  }
}

export async function acknowledgeUnknownRestoreStatus(): Promise<void> {
  const pending = getPendingRestore();
  if (!pending?.statusUnknown) return;
  const assertCurrentOwner = () => {
    const user = queryClient.getQueryData<{ id: string } | null>(queryKeys.session);
    if (user !== undefined && (user?.id ?? 'anonymous') !== pending.owner) {
      throw new Error('Return to the account that started this restore before acknowledging it.');
    }
  };
  assertCurrentOwner();
  const verifyServerOwner = async () => {
    const { user } = await getCurrentUser();
    assertCurrentOwner();
    queryClient.setQueryData(queryKeys.session, user);
    assertCurrentOwner();
  };
  // Cookies are shared across tabs, while the cached session may still belong to
  // the previous user. An unknown job has no status response to verify its owner.
  await verifyServerOwner();
  if (hasLocalDataBridge())
    await localInvoke('sync', 'reconcileRestore', {
      userId: pending.owner === 'anonymous' ? null : pending.owner,
      mode: pending.mode,
    });
  assertCurrentOwner();
  await refreshRestoredLibrary();
  await verifyServerOwner();
  assertCurrentOwner();
  clearPendingRestore(pending.id);
  toast({
    description:
      'The current server library was refreshed. The previous restore result could not be confirmed; review your data before continuing.',
  });
}

async function refreshRestoredLibrary(): Promise<void> {
  // Source catalog failures must not hold a completed restore hostage. Mark every
  // cache stale, but require the restored library and shelf state to refresh.
  await queryClient.invalidateQueries({ refetchType: 'none' });
  for (const queryKey of [queryKeys.mangaLibrary, queryKeys.libraryState]) {
    if (!onlineManager.isOnline()) {
      throw new Error('The restored library could not be refreshed while offline.');
    }
    await queryClient.invalidateQueries({ queryKey, refetchType: 'all' }, { throwOnError: true });
    // TanStack resolves refetches that are paused while offline. They have not
    // supplied current data, so keep the blocker until a later status check retries.
    if (
      queryClient
        .getQueryCache()
        .findAll({ queryKey })
        .some((query) => !query.isDisabled() && query.state.isInvalidated)
    ) {
      throw new Error('The restored library could not be refreshed yet.');
    }
  }
}

export function clearPendingRestore(id: string): void {
  if (getPendingRestore()?.id === id) {
    localStorage.removeItem(storageKey);
    window.dispatchEvent(new Event('projekt-manga-restore-finished'));
  }
}

export async function cancelPendingRestore(): Promise<'cancelled' | 'running'> {
  const pending = getPendingRestore();
  if (!pending || pending.failed || pending.cancelled) return 'cancelled';
  const job = await cancelReplaceRestore(pending.id, pending.owner);
  if (job.state === 'cancelled') {
    localStorage.setItem(storageKey, JSON.stringify({ ...pending, cancelled: true }));
    window.dispatchEvent(new Event('projekt-manga-restore-started'));
    return 'cancelled';
  }
  return 'running';
}

function saveRestoreProgress(id: string, progress: PendingRestore['progress']): void {
  const pending = getPendingRestore();
  if (!pending || pending.id !== id || pending.failed) return;
  localStorage.setItem(storageKey, JSON.stringify({ ...pending, progress }));
  window.dispatchEvent(new Event('projekt-manga-restore-progress'));
}

export async function checkPendingRestore(
  owner: string,
  signal?: AbortSignal,
): Promise<'idle' | 'waiting' | 'finished' | 'failed' | 'cancelled' | 'unknown'> {
  const pending = getPendingRestore();
  if (!pending || pending.owner !== owner) return 'idle';
  if (pending.failed) return 'failed';
  if (pending.cancelled) return 'cancelled';
  if (pending.statusUnknown) return 'unknown';
  let job;
  try {
    job = await getReplaceRestore(pending.id, owner, signal);
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof ApiError && error.status === 404) {
      if (Date.now() - pending.startedAt < 120_000) return 'waiting';
      // The server cannot prove whether a database reset or endpoint change lost a completed job.
      localStorage.setItem(storageKey, JSON.stringify({ ...pending, statusUnknown: true }));
      window.dispatchEvent(new Event('projekt-manga-restore-started'));
      toast({
        description:
          'The server no longer has this restore job. Its result is unknown, so the library remains blocked until you review the current server data.',
      });
      return 'unknown';
    }
    throw error;
  }
  signal?.throwIfAborted();
  saveRestoreProgress(pending.id, job.progress);
  if (job.state === 'queued' || job.state === 'running') return 'waiting';
  if (job.state === 'cancelled') {
    localStorage.setItem(storageKey, JSON.stringify({ ...pending, cancelled: true }));
    window.dispatchEvent(new Event('projekt-manga-restore-started'));
    return 'cancelled';
  }
  if (job.state === 'failed') {
    localStorage.setItem(storageKey, JSON.stringify({ ...pending, failed: true }));
    window.dispatchEvent(new Event('projekt-manga-restore-started'));
    toast({ description: 'Restore failed. Your previous library and history were kept.' });
    return 'failed';
  }
  if (job.state !== 'succeeded') throw new Error('Unexpected restore status from server');
  if (hasLocalDataBridge())
    await localInvoke('sync', 'reconcileRestore', {
      userId: owner === 'anonymous' ? null : owner,
      mode: pending.mode,
    });
  signal?.throwIfAborted();
  if (Object.keys(pending.settings).length > 0) {
    setState((current) => ({
      settings:
        pending.mode === 'merge'
          ? { ...current.settings, ...profileSettingsForImport(pending.settings, owner) }
          : replaceProfileSettings(current.settings, pending.settings, owner),
    }));
  }
  await refreshRestoredLibrary();
  signal?.throwIfAborted();
  clearPendingRestore(pending.id);
  const result = job.result;
  toast({
    description: result
      ? `Restored ${result.restoredManga} titles, ${result.restoredProgress} saved positions, and ${result.restoredHistory} history entries.${pending.skippedDownloads > 0 ? ' Downloaded files were not restored.' : ''}`
      : 'Backup restored.',
  });
  return 'finished';
}
