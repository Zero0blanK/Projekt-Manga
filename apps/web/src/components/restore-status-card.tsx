'use client';

import { useEffect, useState } from 'react';
import {
  acknowledgeUnknownRestoreStatus,
  acknowledgeRestoreFailure,
  cancelPendingRestore,
  discardTrackedRestore,
  getPendingRestore,
} from '@/lib/restore-job';
import { useCurrentUser } from '@/lib/session-resource';
import { RestoreAccountRecovery } from '@/components/settings/account-panel';

const subscribe = (listener: () => void) => {
  window.addEventListener('projekt-manga-restore-started', listener);
  window.addEventListener('projekt-manga-restore-finished', listener);
  window.addEventListener('projekt-manga-restore-progress', listener);
  window.addEventListener('storage', listener);
  return () => {
    window.removeEventListener('projekt-manga-restore-started', listener);
    window.removeEventListener('projekt-manga-restore-finished', listener);
    window.removeEventListener('projekt-manga-restore-progress', listener);
    window.removeEventListener('storage', listener);
  };
};

/**
 * Where a library restore stands, in a corner of the app while it runs.
 *
 * Restores used to take over the whole app until they finished. They now run in the
 * background: reading carries on and what is read meanwhile is kept (lib/restore-job.ts,
 * and the desktop's reconcile in apps/desktop/src/main/db/local-store.ts). This card shows
 * the progress, and afterwards anything that needs the reader: a failure or cancellation to
 * acknowledge, a result the server lost, or a restore belonging to another account.
 */
export function RestoreStatusCard() {
  const [pending, setPending] = useState(getPendingRestore);
  const [cancelMessage, setCancelMessage] = useState('');
  const [refreshingUnknownStatus, setRefreshingUnknownStatus] = useState(false);
  const [unknownStatusMessage, setUnknownStatusMessage] = useState('');
  const { user, loading: userLoading } = useCurrentUser();
  const ownerMatches = !!pending && !userLoading && pending.owner === (user?.id ?? 'anonymous');
  const ownerMismatch = !!pending && !userLoading && !ownerMatches;
  useEffect(() => {
    const refresh = () => setPending(getPendingRestore());
    const unsubscribe = subscribe(refresh);
    refresh();
    return unsubscribe;
  }, []);
  if (!pending) return null;
  const failed = pending.failed === true;
  const cancelled = pending.cancelled === true;
  const statusUnknown = pending.statusUnknown === true;
  const running = !failed && !cancelled && !statusUnknown;
  const progress = pending.progress;
  const hasProgress = ownerMatches && !!progress && progress.total > 0;
  const progressPercent = hasProgress
    ? Math.min(100, Math.floor((progress.completed / progress.total) * 100))
    : undefined;
  const needsAttention = !running || ownerMismatch;

  return (
    <section
      className="fixed bottom-4 left-4 z-50 w-[min(24rem,calc(100vw-2rem))] rounded-xl border bg-card p-4 text-card-foreground shadow-xl"
      role={needsAttention ? 'alert' : 'status'}
      aria-live="polite"
      aria-labelledby="restore-status-title"
      aria-describedby="restore-status-description"
    >
      {running && (
        <div
          className="mb-3 h-1.5 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-label={
            ownerMismatch
              ? 'Restore waiting for the original account'
              : userLoading
                ? 'Checking restore account'
                : 'Restore in progress'
          }
          aria-valuemin={ownerMatches && hasProgress ? 0 : undefined}
          aria-valuemax={ownerMatches && hasProgress ? progress.total : undefined}
          aria-valuenow={ownerMatches && hasProgress ? progress.completed : undefined}
          aria-valuetext={
            ownerMismatch
              ? 'Waiting for the original account'
              : userLoading
                ? 'Checking account ownership'
                : hasProgress
                  ? `${progressPercent}% complete`
                  : 'Working'
          }
        >
          {ownerMatches && (
            <div
              className={`h-full rounded-full bg-primary ${hasProgress ? '' : 'w-1/3 animate-pulse'}`}
              style={hasProgress ? { width: `${progressPercent}%` } : undefined}
            />
          )}
        </div>
      )}
      <h2 id="restore-status-title" className="text-sm font-semibold">
        {ownerMismatch
          ? 'Restore belongs to another account'
          : userLoading
            ? 'Checking restore account'
            : statusUnknown
              ? 'Restore result could not be confirmed'
              : cancelled
                ? 'Restore cancelled'
                : failed
                  ? 'Restore could not be completed'
                  : 'Restoring your library'}
      </h2>
      <p id="restore-status-description" className="mt-1 text-xs text-muted-foreground">
        {ownerMismatch
          ? 'This restore was started by a different account. Switch back to it to follow the restore, or stop tracking it here.'
          : userLoading
            ? 'Checking which account owns this restore.'
            : statusUnknown
              ? 'The server no longer has this restore job, so it cannot confirm whether it completed. Refresh the current server data and review your library.'
              : cancelled
                ? 'The restore was cancelled before processing began. Your existing library and history are unchanged.'
                : failed
                  ? 'The restore transaction was rolled back. Your previous library and history are intact. A retry can be started from Settings.'
                  : 'Keep reading if you like: anything you read meanwhile is kept. The library refreshes when the restore finishes.'}
      </p>
      {ownerMismatch && <RestoreAccountRecovery />}
      {running && ownerMatches && (
        <p className="mt-2 text-xs">
          {progress?.phase ?? 'Waiting for the server to start the restore…'}
          {hasProgress ? ` · ${progress.completed} of ${progress.total} records` : ''}
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {running && ownerMatches && !progress && (
          <button
            type="button"
            className="rounded-md border border-border px-3 py-1.5 text-xs"
            onClick={() => {
              setCancelMessage('');
              void cancelPendingRestore()
                .then((state) => {
                  if (state === 'running')
                    setCancelMessage(
                      'Processing has started; this restore can no longer be cancelled.',
                    );
                })
                .catch(() => setCancelMessage("Couldn't check cancellation status."));
            }}
          >
            Cancel before processing starts
          </button>
        )}
        {statusUnknown && ownerMatches && (
          <button
            type="button"
            className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50"
            disabled={refreshingUnknownStatus}
            onClick={() => {
              setRefreshingUnknownStatus(true);
              setUnknownStatusMessage('');
              void acknowledgeUnknownRestoreStatus()
                .catch(() =>
                  setUnknownStatusMessage("Couldn't refresh the current library. Try again."),
                )
                .finally(() => setRefreshingUnknownStatus(false));
            }}
          >
            {refreshingUnknownStatus ? 'Refreshing current library…' : 'Refresh and acknowledge'}
          </button>
        )}
        {(failed || cancelled) && ownerMatches && (
          <button
            type="button"
            className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground"
            onClick={acknowledgeRestoreFailure}
          >
            Acknowledge
          </button>
        )}
        {/* For a restore this browser can't resolve: its account is gone, or the server
            lost its result. Nothing changes on the server. */}
        {(ownerMismatch || statusUnknown) && (
          <button
            type="button"
            className="rounded-md border border-border px-3 py-1.5 text-xs"
            onClick={discardTrackedRestore}
          >
            Stop tracking this restore
          </button>
        )}
      </div>
      {cancelMessage && <p className="mt-2 text-xs text-muted-foreground">{cancelMessage}</p>}
      {unknownStatusMessage && (
        <p className="mt-2 text-xs text-muted-foreground" role="alert">
          {unknownStatusMessage}
        </p>
      )}
    </section>
  );
}
