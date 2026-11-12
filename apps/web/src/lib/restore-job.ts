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
  setProgressWriteHold,
  startReplaceRestore,
} from '@projekt-manga/api-client';
import { isRestoreActive } from '@projekt-manga/types';
import { toast } from '@/hooks/use-toast';
import { setState } from './app-store';
import { queryClient, queryKeys } from './query-client';
import { profileSettingsForImport, replaceProfileSettings } from './profile-settings';
import { applyMihonImportExtras, clearMihonImportExtras } from './mihon-backup/extras';

/**
 * The restore this browser is tracking: the one record of it (localStorage, so it
 * survives a reload and is seen by other tabs), what state it is in, and the only code
 * that changes it. Everything else asks through the functions here and hears of changes
 * through `subscribeToRestore`.
 *
 * The server's job has its own states (`RestoreState` in packages/types). This side adds
 * what only a client can be in: still uploading, and "unknown", when the server no longer
 * has the job and cannot say how it ended.
 */
const storageKey = 'projekt-manga-pending-restore';

/**
 * What changed about the tracked restore:
 * - `started`: one began, or its status changed (failed, cancelled, unknown);
 * - `finished`: it stopped being tracked;
 * - `progress`: only its progress figures moved.
 */
export type RestoreChange = 'started' | 'finished' | 'progress';
const ALL_CHANGES: readonly RestoreChange[] = ['started', 'finished', 'progress'];
const eventName = (change: RestoreChange) => `projekt-manga-restore-${change}`;

/**
 * Calls `listener` when the tracked restore changes in one of the given ways, in this
 * tab or another. Returns the unsubscribe.
 */
export function subscribeToRestore(
  listener: () => void,
  changes: readonly RestoreChange[] = ALL_CHANGES,
): () => void {
  for (const change of changes) window.addEventListener(eventName(change), listener);
  window.addEventListener('storage', listener);
  return () => {
    for (const change of changes) window.removeEventListener(eventName(change), listener);
    window.removeEventListener('storage', listener);
  };
}

/** Where a tracked restore stands, as far as this browser knows. */
export type RestoreTracking = 'running' | 'failed' | 'cancelled' | 'unknown';

export function restoreTracking(pending: PendingRestore): RestoreTracking {
  if (pending.failed) return 'failed';
  if (pending.cancelled) return 'cancelled';
  if (pending.statusUnknown) return 'unknown';
  return 'running';
}

/** A restore still being applied, as opposed to one that failed, was cancelled or lost. */
export function isRestoreRunning(): boolean {
  const pending = getPendingRestore();
  return !!pending && restoreTracking(pending) === 'running';
}

/** Settles once no restore is being applied (finished, failed, cancelled or discarded). */
function untilRestoreEnds(): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (isRestoreRunning()) return;
      unsubscribe();
      resolve();
    };
    const unsubscribe = subscribeToRestore(check);
    check();
  });
}

/** The one place the record is written; every change is announced. */
function store(pending: PendingRestore, change: RestoreChange | null): void {
  localStorage.setItem(storageKey, JSON.stringify(pending));
  if (change) window.dispatchEvent(new Event(eventName(change)));
}

// Reading carries on during a restore; progress saves to the server wait for it to end
// rather than failing against the restore's lock (packages/api-client/src/progressHold.ts).
if (typeof window !== 'undefined') {
  setProgressWriteHold(() => (isRestoreRunning() ? untilRestoreEnds() : null));
}

export function useRestorePending(): boolean {
  return useSyncExternalStore(
    (listener) => subscribeToRestore(listener),
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
  /** When the server accepted the upload; unset while a large backup is still uploading. */
  acceptedAt?: number;
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
  store(value, 'started');
}

/**
 * Starts a restore on the server and tracks it here, in the order the tracking depends
 * on: the record exists before the upload begins (so a reload mid-upload still knows of
 * it), the server's "no such job" grace period starts when the upload lands, and a start
 * that failed is forgotten, unless the connection dropped, when the upload may still have
 * arrived. `afterTracked` runs once the record exists and before the upload.
 *
 * Throws what stopped it, for the caller to show; nothing is left to clean up.
 */
export async function startTrackedRestore(
  tracked: Omit<
    PendingRestore,
    'startedAt' | 'acceptedAt' | 'failed' | 'cancelled' | 'statusUnknown' | 'progress'
  >,
  backup: Parameters<typeof startReplaceRestore>[0],
  afterTracked?: () => void,
): Promise<void> {
  savePendingRestore({ ...tracked, startedAt: Date.now() });
  try {
    afterTracked?.();
    await startReplaceRestore(backup);
    markRestoreAccepted(tracked.id);
  } catch (error) {
    if (error instanceof ApiError && (error.kind === 'network' || error.kind === 'timeout')) {
      // The upload may still have arrived; give the server its grace period from now.
      markRestoreAccepted(tracked.id);
    } else {
      clearMihonImportExtras(tracked.id);
      clearPendingRestore(tracked.id);
    }
    throw error;
  }
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
      acceptedAt:
        typeof record.acceptedAt === 'number' && Number.isFinite(record.acceptedAt)
          ? record.acceptedAt
          : undefined,
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
      startedAt: pending.startedAt,
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

/** The server has the restore: its "no such job" grace period starts now. */
export function markRestoreAccepted(id: string): void {
  const pending = getPendingRestore();
  if (pending?.id !== id) return;
  store({ ...pending, acceptedAt: Date.now() }, null);
}

/**
 * Stops tracking a restore this browser can't resolve: one started by an account that no
 * longer exists, or whose result the server lost. Nothing on the server changes; the
 * library is simply used as it is.
 */
export function discardTrackedRestore(): void {
  const pending = getPendingRestore();
  if (!pending) return;
  clearMihonImportExtras(pending.id);
  clearPendingRestore(pending.id);
}

export function clearPendingRestore(id: string): void {
  if (getPendingRestore()?.id === id) {
    localStorage.removeItem(storageKey);
    window.dispatchEvent(new Event(eventName('finished')));
  }
}

export async function cancelPendingRestore(): Promise<'cancelled' | 'running'> {
  const pending = getPendingRestore();
  if (!pending || pending.failed || pending.cancelled) return 'cancelled';
  const job = await cancelReplaceRestore(pending.id, pending.owner);
  if (job.state === 'cancelled') {
    clearMihonImportExtras(pending.id);
    store({ ...pending, cancelled: true }, 'started');
    return 'cancelled';
  }
  return 'running';
}

function saveRestoreProgress(id: string, progress: PendingRestore['progress']): void {
  const pending = getPendingRestore();
  if (!pending || pending.id !== id || pending.failed) return;
  store({ ...pending, progress }, 'progress');
}

export async function checkPendingRestore(
  owner: string,
  signal?: AbortSignal,
): Promise<'idle' | 'waiting' | 'finished' | 'failed' | 'cancelled' | 'unknown'> {
  const pending = getPendingRestore();
  if (!pending || pending.owner !== owner) return 'idle';
  const tracking = restoreTracking(pending);
  if (tracking !== 'running') return tracking;
  let job;
  try {
    job = await getReplaceRestore(pending.id, owner, signal);
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof ApiError && error.status === 404) {
      // Counted from when the server took the upload, not from when it began: a large
      // backup on a slow connection could take longer than this to arrive, and its restore
      // then ran unwatched while the app called the result unknown.
      if (pending.acceptedAt === undefined) {
        if (Date.now() - pending.startedAt < 10 * 60_000) return 'waiting';
      } else if (Date.now() - pending.acceptedAt < 120_000) {
        return 'waiting';
      }
      // The server cannot prove whether a database reset or endpoint change lost a completed job.
      store({ ...pending, statusUnknown: true }, 'started');
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
  if (isRestoreActive(job.state)) return 'waiting';
  if (job.state === 'cancelled') {
    store({ ...pending, cancelled: true }, 'started');
    return 'cancelled';
  }
  if (job.state === 'failed') {
    clearMihonImportExtras(pending.id);
    store({ ...pending, failed: true }, 'started');
    toast({ description: 'Restore failed. Your previous library and history were kept.' });
    return 'failed';
  }
  if (job.state !== 'succeeded') throw new Error('Unexpected restore status from server');
  if (hasLocalDataBridge())
    await localInvoke('sync', 'reconcileRestore', {
      userId: owner === 'anonymous' ? null : owner,
      mode: pending.mode,
      startedAt: pending.startedAt,
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
  // A Mihon import's categories and tracker links need the restored titles' ids.
  const extras = await applyMihonImportExtras(pending.id, owner).catch(() => null);
  const extrasNote = extras
    ? ` Added ${extras.categories} categories and ${extras.trackerLinks} tracker links${extras.skippedTrackerLinks > 0 ? ` (${extras.skippedTrackerLinks} skipped: tracker not connected or link refused)` : ''}.`
    : '';
  const result = job.result;
  toast({
    description: result
      ? `Restored ${result.restoredManga} titles, ${result.restoredProgress} saved positions, and ${result.restoredHistory} history entries.${pending.skippedDownloads > 0 ? ' Downloaded files were not restored.' : ''}${extrasNote}`
      : `Backup restored.${extrasNote}`,
  });
  return 'finished';
}
