'use client';

import { useEffect, useState } from 'react';
import {
  getConnectedTrackers,
  getTrackerAuthorizeUrl,
  disconnectTracker,
  syncTrackersNow,
  ApiError,
  type ConnectedTracker,
  type TrackerName,
} from '@projekt-manga/api-client';
import { Field } from '@/components/settings/field-controls';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { toast } from '@/hooks/use-toast';

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

// Only AniList has a server adapter; MyAnimeList needs MAL's app approval (see trackers/index.ts).
const SUPPORTED: { tracker: TrackerName; label: string }[] = [
  { tracker: 'ANILIST', label: 'AniList' },
];

/** Reads the `tracker_connected=`/`tracker_error=` params the OAuth callback redirects
 * back with (apps/server's tracker.controller.ts `handleCallback`) — they land in the
 * hash (`#account?tracker_connected=...`) rather than the query string, since the whole
 * settings section already lives in the hash. Cleared immediately after reading so a
 * refresh doesn't re-show the same toast. */
function useOAuthRedirectToast(onHandled: () => void) {
  useEffect(() => {
    const hash = window.location.hash;
    const queryIndex = hash.indexOf('?');
    if (queryIndex === -1) return;
    const params = new URLSearchParams(hash.slice(queryIndex + 1));
    const connected = params.get('tracker_connected');
    const error = params.get('tracker_error');
    if (!connected && !error) return;

    if (connected) {
      toast({
        description: `Connected to ${connected.charAt(0) + connected.slice(1).toLowerCase()}.`,
      });
      onHandled();
    } else if (error) {
      toast({ description: error });
    }

    window.history.replaceState(null, '', hash.slice(0, queryIndex));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

export function TrackersPanel() {
  const [connected, setConnected] = useState<ConnectedTracker[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<TrackerName | null>(null);
  const [syncing, setSyncing] = useState(false);

  const load = () => {
    setLoading(true);
    getConnectedTrackers()
      .then(setConnected)
      .catch(() => toast({ description: "Couldn't load connected trackers." }))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);
  useOAuthRedirectToast(load);

  const handleConnect = (tracker: TrackerName) => {
    setBusy(tracker);
    getTrackerAuthorizeUrl(tracker)
      .then(({ url }) => {
        window.location.href = url;
      })
      .catch((error) => {
        toast({ description: errorMessage(error, "Couldn't start that connection.") });
        setBusy(null);
      });
  };

  /** Account-wide, not per-tracker: the endpoint reconciles every link this account has,
   * which is also what a reader means by "sync" here. Server-side capped, so repeated
   * clicks can't turn into an unbounded burst of upstream requests. */
  const handleSyncNow = () => {
    setSyncing(true);
    syncTrackersNow()
      .then(({ checked, updated }) =>
        toast({
          description:
            checked === 0
              ? 'No linked titles to sync yet.'
              : `Synced ${checked} title${checked === 1 ? '' : 's'}${updated > 0 ? `, ${updated} updated` : ''}.`,
        }),
      )
      .catch((error) => toast({ description: errorMessage(error, 'Sync failed — try again.') }))
      .finally(() => setSyncing(false));
  };

  const handleDisconnect = (tracker: TrackerName) => {
    setBusy(tracker);
    disconnectTracker(tracker)
      .then(() => {
        toast({ description: 'Disconnected.' });
        load();
      })
      .catch((error) =>
        toast({ description: errorMessage(error, "Couldn't disconnect — try again.") }),
      )
      .finally(() => setBusy(null));
  };

  return (
    <>
      {SUPPORTED.map(({ tracker, label }) => {
        const account = connected.find((c) => c.tracker === tracker);
        const isBusy = busy === tracker;
        return (
          <Field
            key={tracker}
            label={label}
            hint={
              loading
                ? 'Checking…'
                : account
                  ? `Connected as ${account.tracker_username}`
                  : 'Sync reading progress with your account'
            }
          >
            {account ? (
              <div className="flex items-center gap-2">
                <button
                  onClick={handleSyncNow}
                  disabled={syncing || isBusy}
                  className="rounded-lg border border-border/60 px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-accent disabled:opacity-50"
                >
                  {syncing ? 'Syncing…' : 'Sync now'}
                </button>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <button
                      disabled={isBusy}
                      className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs font-medium text-destructive transition hover:bg-destructive/20 disabled:opacity-50"
                    >
                      {isBusy ? '…' : 'Disconnect'}
                    </button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Disconnect {label}?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This removes every title you've linked to {label} along with the connection
                        itself. Your local reading progress is unaffected.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={() => handleDisconnect(tracker)}>
                        Disconnect
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            ) : (
              <button
                onClick={() => handleConnect(tracker)}
                disabled={isBusy || loading}
                className="rounded-lg border border-border/60 px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-accent disabled:opacity-50"
              >
                {isBusy ? 'Redirecting…' : 'Connect'}
              </button>
            )}
          </Field>
        );
      })}
    </>
  );
}
