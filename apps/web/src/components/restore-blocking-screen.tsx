'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  acknowledgeUnknownRestoreStatus,
  acknowledgeRestoreFailure,
  cancelPendingRestore,
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

export function RestoreBlockingScreen() {
  const [pending, setPending] = useState(getPendingRestore);
  const [cancelMessage, setCancelMessage] = useState('');
  const [refreshingUnknownStatus, setRefreshingUnknownStatus] = useState(false);
  const [unknownStatusMessage, setUnknownStatusMessage] = useState('');
  const { user, loading: userLoading } = useCurrentUser();
  const heading = useRef<HTMLHeadingElement>(null);
  const pendingId = pending?.id;
  const ownerMatches = !!pending && !userLoading && pending.owner === (user?.id ?? 'anonymous');
  const ownerMismatch = !!pending && !userLoading && !ownerMatches;
  useEffect(() => {
    const refresh = () => setPending(getPendingRestore());
    const unsubscribe = subscribe(refresh);
    refresh();
    return unsubscribe;
  }, []);
  useEffect(() => {
    if (pendingId) heading.current?.focus();
  }, [pendingId, pending?.failed, pending?.cancelled, pending?.statusUnknown]);
  if (!pending) return null;
  const failed = pending.failed === true;
  const cancelled = pending.cancelled === true;
  const statusUnknown = pending.statusUnknown === true;
  const progress = pending.progress;
  const hasProgress = ownerMatches && !!progress && progress.total > 0;
  const progressPercent = hasProgress
    ? Math.min(100, Math.floor((progress.completed / progress.total) * 100))
    : undefined;
  const keepFocusInside = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return;
    const actions = event.currentTarget.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    if (actions.length === 0) {
      event.preventDefault();
      heading.current?.focus();
      return;
    }
    const first = actions[0];
    const last = actions[actions.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] grid place-items-center bg-background/95 p-6 backdrop-blur-sm"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="restore-status-title"
      aria-describedby="restore-status-description"
      onKeyDown={keepFocusInside}
    >
      <section className="w-full max-w-lg rounded-xl border bg-card p-6 text-card-foreground shadow-xl">
        {!failed && !cancelled && !statusUnknown && (
          <div
            className="mb-5 h-1.5 overflow-hidden rounded-full bg-muted"
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
        <h1 ref={heading} id="restore-status-title" tabIndex={-1} className="text-xl font-semibold">
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
        </h1>
        <p id="restore-status-description" className="mt-2 text-sm text-muted-foreground">
          {ownerMismatch
            ? 'This restore was started by a different account. The library remains blocked and no completion has been assumed. Switch back to the account that started the restore; status checks will resume automatically when its session is active.'
            : userLoading
              ? 'Checking which account owns this restore. The library stays blocked until ownership is confirmed.'
              : statusUnknown
                ? 'The server no longer has this restore job, so it cannot confirm whether it completed. Your library stays blocked until you refresh the current server data and acknowledge that the restore result is unknown.'
                : cancelled
                  ? 'The restore was cancelled before processing began. Your existing library and history are unchanged.'
                  : failed
                    ? 'The restore transaction was rolled back. Your previous library and history are intact. A retry can be started from Settings after you acknowledge this result.'
                    : 'Your data is being applied safely. Keep this app open while it runs. We will refresh your library before returning you to the app.'}
        </p>
        {ownerMismatch && <RestoreAccountRecovery />}
        {!failed && !cancelled && !statusUnknown && ownerMatches && (
          <p className="mt-4 text-sm">
            {progress?.phase ?? 'Waiting for the server to report the restore status…'}
            {hasProgress ? ` · ${progress.completed} of ${progress.total} records` : ''}
          </p>
        )}
        {!failed && !cancelled && !statusUnknown && ownerMatches && !progress && (
          <button
            type="button"
            className="mt-5 rounded-md border border-border px-4 py-2 text-sm"
            onClick={() => {
              setCancelMessage('');
              void cancelPendingRestore()
                .then((state) => {
                  if (state === 'running')
                    setCancelMessage(
                      'Processing has started; this restore can no longer be cancelled.',
                    );
                })
                .catch(() => setCancelMessage('Could not check cancellation status.'));
            }}
          >
            Cancel before processing starts
          </button>
        )}
        {cancelMessage && <p className="mt-2 text-sm text-muted-foreground">{cancelMessage}</p>}
        {statusUnknown && ownerMatches && (
          <>
            <button
              type="button"
              className="mt-5 rounded-md bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50"
              disabled={refreshingUnknownStatus}
              onClick={() => {
                setRefreshingUnknownStatus(true);
                setUnknownStatusMessage('');
                void acknowledgeUnknownRestoreStatus()
                  .catch(() =>
                    setUnknownStatusMessage(
                      'Could not refresh the current library. Keep this screen open and try again.',
                    ),
                  )
                  .finally(() => setRefreshingUnknownStatus(false));
              }}
            >
              {refreshingUnknownStatus ? 'Refreshing current library…' : 'Refresh and acknowledge'}
            </button>
            {unknownStatusMessage && (
              <p className="mt-2 text-sm text-muted-foreground" role="alert">
                {unknownStatusMessage}
              </p>
            )}
          </>
        )}
        {(failed || cancelled) && ownerMatches && (
          <button
            type="button"
            className="mt-5 rounded-md bg-primary px-4 py-2 text-primary-foreground"
            onClick={acknowledgeRestoreFailure}
            autoFocus
          >
            Acknowledge
          </button>
        )}
      </section>
    </div>
  );
}
