'use client';

import { hasLocalDataBridge, localInvoke } from '@projekt-manga/api-client';
import { useSyncExternalStore } from 'react';
import { getSetting } from '@/lib/app-store';

type SyncState = {
  running: boolean;
  lastAttempt: number | null;
  lastSuccess: number | null;
  retryAfter: number | null;
  error: string | null;
  failedRows: number;
};
let state: SyncState = {
  running: false,
  lastAttempt: null,
  lastSuccess: null,
  retryAfter: null,
  error: null,
  failedRows: 0,
};
const listeners = new Set<() => void>();
let currentRun: Promise<void> | null = null;
let currentAccount: string | null = null;
let consecutiveFailures = 0;

const nextRetryTime = (): number => {
  consecutiveFailures += 1;
  const delayMs = Math.min(60_000 * 2 ** (consecutiveFailures - 1), 30 * 60_000);
  return Date.now() + delayMs;
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const snapshot = () => state;
const setState = (next: Partial<SyncState>) => {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
};

export function useDesktopSyncState(): SyncState {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function setDesktopSyncAccount(accountId: string | null): void {
  if (currentAccount === accountId) return;
  currentAccount = accountId;
  consecutiveFailures = 0;
  setState({
    lastAttempt: null,
    lastSuccess: null,
    retryAfter: null,
    error: null,
    failedRows: 0,
  });
}

export function runDesktopSync(): Promise<void> {
  if (!hasLocalDataBridge()) return Promise.resolve();
  if (getSetting('desktopSyncEnabled', true) !== true) return Promise.resolve();
  if (currentRun) return currentRun;
  const accountAtStart = currentAccount;
  setState({ running: true, lastAttempt: Date.now(), error: null });
  currentRun = localInvoke<unknown>('sync', 'run')
    .then((result) => {
      if (currentAccount !== accountAtStart) return;
      if (!result || typeof result !== 'object' || !('pulled' in result)) {
        throw new Error('Sign in on this device to sync');
      }
      const pulled = result.pulled;
      if (
        !pulled ||
        typeof pulled !== 'object' ||
        !['library', 'manga_state', 'chapter_state', 'manga_category', 'history'].every(
          (key) => typeof (pulled as Record<string, unknown>)[key] === 'number',
        )
      ) {
        throw new Error('Unexpected desktop sync response');
      }
      const pushed =
        'pushed' in result && result.pushed && typeof result.pushed === 'object'
          ? Object.values(result.pushed)
          : [];
      const failedRows = pushed.reduce<number>((count, domain) => {
        if (
          !domain ||
          typeof domain !== 'object' ||
          !('failed' in domain) ||
          !Array.isArray(domain.failed)
        )
          throw new Error('Unexpected desktop sync response');
        return count + domain.failed.length;
      }, 0);
      if (failedRows === 0) consecutiveFailures = 0;
      setState({
        lastSuccess: failedRows === 0 ? Date.now() : state.lastSuccess,
        retryAfter: failedRows === 0 ? null : nextRetryTime(),
        failedRows,
        error: failedRows
          ? `${failedRows} row${failedRows === 1 ? '' : 's'} could not be pushed; retry sync`
          : null,
      });
    })
    .catch((error: unknown) => {
      if (currentAccount !== accountAtStart) return;
      setState({
        retryAfter: nextRetryTime(),
        error: error instanceof Error ? error.message : 'Sync failed; retry sync',
      });
    })
    .finally(() => {
      currentRun = null;
      setState({ running: false });
    });
  return currentRun;
}
