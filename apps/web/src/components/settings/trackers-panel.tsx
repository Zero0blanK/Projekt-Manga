'use client';

import { useLatest } from '@/lib/use-latest';
import { useEffect, useState, type FormEvent } from 'react';
import {
  getAvailableTrackers,
  getConnectedTrackers,
  getTrackerAuthorizeUrl,
  connectTrackerWithCredentials,
  disconnectTracker,
  syncTrackersNow,
  ApiError,
  type ConnectedTracker,
  type TrackerAvailability,
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
import { websiteUrl } from '@/lib/source-url';

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

const BUTTON =
  'rounded-lg border border-border/60 px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-accent disabled:opacity-50';
const INPUT =
  'w-full rounded-lg border border-border/60 bg-background px-3 py-1.5 text-xs text-foreground outline-none focus:border-primary/60 disabled:opacity-60 sm:w-72';

/** For the OAuth redirect toast, which can fire before the server's list has loaded. */
const OAUTH_LABELS: Partial<Record<string, string>> = {
  ANILIST: 'AniList',
  MYANIMELIST: 'MyAnimeList',
  SHIKIMORI: 'Shikimori',
  BANGUMI: 'Bangumi',
};

function hintFor(entry: TrackerAvailability): string {
  if (!entry.available) return "Not set up on this server — its app credentials aren't configured";
  if (entry.auth_kind === 'api_key') return 'Sync reading progress with your own server';
  return 'Sync reading progress with your account';
}

/**
 * Inline connect form for trackers that don't use an OAuth redirect: username/password
 * (Kitsu, MangaUpdates) or a self-hosted server URL plus API key (Komga, Kavita). The
 * values only live in this form's state until submitted; the server exchanges them for a
 * token and keeps no password.
 */
function CredentialForm({
  entry,
  onConnected,
  onCancel,
}: {
  entry: TrackerAvailability;
  onConnected: () => void;
  onCancel: () => void;
}) {
  const isServer = entry.auth_kind === 'api_key';
  const [identity, setIdentity] = useState('');
  const [secret, setSecret] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!identity.trim() || !secret || submitting) return;
    setSubmitting(true);
    connectTrackerWithCredentials(
      entry.tracker,
      isServer
        ? { base_url: identity.trim(), api_key: secret.trim() }
        : { username: identity.trim(), password: secret },
    )
      .then((account) => {
        toast({ description: `Connected to ${entry.label} as ${account.tracker_username}.` });
        onConnected();
      })
      .catch((error) => {
        setSecret('');
        toast({ description: errorMessage(error, `Couldn't connect to ${entry.label}.`) });
      })
      .finally(() => setSubmitting(false));
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-2" autoComplete="off">
      <input
        type={isServer ? 'url' : 'text'}
        value={identity}
        onChange={(e) => setIdentity(e.target.value)}
        placeholder={
          isServer ? `https://${entry.label.toLowerCase()}.example.com` : 'Username or email'
        }
        aria-label={isServer ? `${entry.label} server URL` : `${entry.label} username`}
        autoComplete="off"
        disabled={submitting}
        className={INPUT}
      />
      <input
        type="password"
        value={secret}
        onChange={(e) => setSecret(e.target.value)}
        placeholder={isServer ? 'API key' : 'Password'}
        aria-label={isServer ? `${entry.label} API key` : `${entry.label} password`}
        // Another service's secret: keep the browser from offering to save it as this
        // app's own login.
        autoComplete="new-password"
        disabled={submitting}
        className={INPUT}
      />
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={submitting || !identity.trim() || !secret}
          className={BUTTON}
        >
          {submitting ? 'Connecting…' : 'Connect'}
        </button>
        <button type="button" onClick={onCancel} disabled={submitting} className={BUTTON}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Reads the `tracker_connected=`/`tracker_error=` params the OAuth callback redirects
 * back with (apps/server's tracker.controller.ts `handleCallback`) — they land in the
 * hash (`#account?tracker_connected=...`) rather than the query string, since the whole
 * settings section already lives in the hash. Cleared immediately after reading so a
 * refresh doesn't re-show the same toast. */
function useOAuthRedirectToast(onHandled: () => void) {
  const handled = useLatest(onHandled);
  useEffect(() => {
    const hash = window.location.hash;
    const queryIndex = hash.indexOf('?');
    if (queryIndex === -1) return;
    const params = new URLSearchParams(hash.slice(queryIndex + 1));
    const connected = params.get('tracker_connected');
    const error = params.get('tracker_error');
    if (!connected && !error) return;

    if (connected) {
      const label =
        OAUTH_LABELS[connected.toUpperCase()] ??
        connected.charAt(0).toUpperCase() + connected.slice(1).toLowerCase();
      toast({ description: `Connected to ${label}.` });
      handled.current();
    } else if (error) {
      toast({ description: error });
    }

    window.history.replaceState(null, '', hash.slice(0, queryIndex));
  }, [handled]);
}

export function TrackersPanel() {
  const [trackers, setTrackers] = useState<TrackerAvailability[]>([]);
  const [connected, setConnected] = useState<ConnectedTracker[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<TrackerName | null>(null);
  const [formFor, setFormFor] = useState<TrackerName | null>(null);
  const [syncing, setSyncing] = useState(false);

  const load = () => {
    setLoading(true);
    Promise.all([getAvailableTrackers(), getConnectedTrackers()])
      .then(([available, accounts]) => {
        setTrackers(available);
        setConnected(accounts);
      })
      .catch(() => toast({ description: "Couldn't load connected trackers." }))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);
  useOAuthRedirectToast(load);

  const handleConnect = ({ tracker, auth_kind }: TrackerAvailability) => {
    if (auth_kind !== 'oauth') {
      setFormFor(tracker);
      return;
    }
    setBusy(tracker);
    getTrackerAuthorizeUrl(tracker)
      .then(({ url }) => {
        const target = websiteUrl(url);
        if (!target) throw new Error('The tracker sent an address that cannot be opened.');
        window.location.href = target;
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

  if (loading && trackers.length === 0) {
    return <p className="text-xs text-muted-foreground">Checking…</p>;
  }

  return (
    <>
      {trackers.map((entry) => {
        const { tracker, label } = entry;
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
                  : hintFor(entry)
            }
          >
            {account ? (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleSyncNow}
                  disabled={syncing || isBusy}
                  className={BUTTON}
                >
                  {syncing ? 'Syncing…' : 'Sync now'}
                </button>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <button
                      type="button"
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
            ) : formFor === tracker ? (
              <CredentialForm
                entry={entry}
                onConnected={() => {
                  setFormFor(null);
                  load();
                }}
                onCancel={() => setFormFor(null)}
              />
            ) : (
              <button
                type="button"
                onClick={() => handleConnect(entry)}
                disabled={isBusy || loading || !entry.available}
                className={BUTTON}
              >
                {!entry.available ? 'Unavailable' : isBusy ? 'Redirecting…' : 'Connect'}
              </button>
            )}
          </Field>
        );
      })}
    </>
  );
}
