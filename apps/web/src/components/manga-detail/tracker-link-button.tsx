'use client';

import { useEffect, useState } from 'react';
import {
  getConnectedTrackers,
  getMangaTrackerLinks,
  searchTrackerMedia,
  linkMangaToTracker,
  unlinkMangaFromTracker,
  syncTrackersNow,
  ApiError,
  type TrackerLink,
  type TrackerSearchResult,
} from '@projekt-manga/api-client';
import { useCurrentUser } from '@/lib/session-resource';
import { useLibraryState, libraryActions } from '@/lib/library-store';
import { formatRelative, type Manga } from '@/lib/manga-data';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Link2 } from 'lucide-react';
import { toast } from '@/hooks/use-toast';

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

const TRACKER = 'ANILIST' as const;
const TRACKER_LABEL = 'AniList';

/** A plain 0-10 rating, converted to this app's fixed 0-100 scale on save. */
function ScoreControl({ manga }: { manga: Manga }) {
  const { score } = useLibraryState();
  const currentScore = score[manga.id];
  const [input, setInput] = useState(currentScore != null ? String(currentScore / 10) : '');
  const [edited, setEdited] = useState(false);
  const [saving, setSaving] = useState(false);

  // Library state resolves asynchronously. Do not replace text the reader has started
  // entering while that initial score arrives.
  useEffect(() => {
    if (!edited) setInput(currentScore != null ? String(currentScore / 10) : '');
  }, [currentScore, edited]);

  const save = () => {
    const value = Number(input);
    if (!Number.isFinite(value) || value < 0 || value > 10) {
      toast({ description: 'Enter a rating from 0 to 10.' });
      return;
    }
    setSaving(true);
    libraryActions
      .setScore(manga.id, Math.round(value * 10))
      .then(() => toast({ description: 'Rating saved.' }))
      .catch(() => toast({ description: "Couldn't save your rating — try again." }))
      .finally(() => setSaving(false));
  };

  return (
    <div className="flex items-center gap-2">
      <Input
        type="number"
        min={0}
        max={10}
        step={0.5}
        value={input}
        onChange={(e) => {
          setEdited(true);
          setInput(e.target.value);
        }}
        onKeyDown={(e) => e.key === 'Enter' && save()}
        placeholder="0-10"
        className="h-8 w-20 text-xs"
      />
      <button
        onClick={save}
        disabled={saving || !input.trim()}
        className="rounded-lg border border-border/60 px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-accent disabled:opacity-50"
      >
        {saving ? '…' : 'Save rating'}
      </button>
    </div>
  );
}

/**
 * Progress, status and score push automatically as you read, but a push is best-effort:
 * a tracker being down or rate-limiting means it silently doesn't land until the
 * background reconcile repairs it. Showing the last sync time, plus a way to force one,
 * makes that failure visible and actionable.
 *
 * The server stamps `last_synced_at` as part of the sync it just ran, so setting it to
 * "now" locally on success is accurate and saves a refetch of the whole link.
 */
function SyncStatus({ link }: { link: TrackerLink }) {
  const [lastSyncedAt, setLastSyncedAt] = useState(link.last_synced_at);
  const [syncing, setSyncing] = useState(false);

  const sync = () => {
    setSyncing(true);
    syncTrackersNow()
      .then(({ checked, updated }) => {
        if (checked === 0) {
          toast({ description: 'Nothing to sync.' });
          return;
        }
        setLastSyncedAt(new Date().toISOString());
        toast({
          description: `Synced ${checked} title${checked === 1 ? '' : 's'}${updated > 0 ? `, ${updated} updated` : ''}.`,
        });
      })
      .catch((error) => toast({ description: errorMessage(error, 'Sync failed — try again.') }))
      .finally(() => setSyncing(false));
  };

  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-muted-foreground">
        {lastSyncedAt ? `Last synced ${formatRelative(lastSyncedAt)}` : 'Not synced yet'}
      </span>
      <button
        onClick={sync}
        disabled={syncing}
        className="shrink-0 rounded-lg border border-border/60 px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-accent disabled:opacity-50"
      >
        {syncing ? 'Syncing…' : 'Sync now'}
      </button>
    </div>
  );
}

function LinkDialogBody({
  manga,
  existingLink,
  onLinked,
  onUnlinked,
}: {
  manga: Manga;
  existingLink: TrackerLink | null;
  onLinked: (link: TrackerLink) => void;
  onUnlinked: () => void;
}) {
  const [query, setQuery] = useState(manga.title);
  const [results, setResults] = useState<TrackerSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const runSearch = () => {
    const q = query.trim();
    if (!q || searching) return;
    setSearching(true);
    searchTrackerMedia(TRACKER, q)
      .then(setResults)
      .catch((error) => toast({ description: errorMessage(error, 'Search failed — try again.') }))
      .finally(() => setSearching(false));
  };

  const link = (tracker_media_id: string) => {
    setBusyId(tracker_media_id);
    linkMangaToTracker(manga.id, { tracker: TRACKER, tracker_media_id })
      .then((newLink) => {
        toast({ description: `Linked to ${TRACKER_LABEL}.` });
        onLinked(newLink);
      })
      .catch((error) => toast({ description: errorMessage(error, "Couldn't link that title.") }))
      .finally(() => setBusyId(null));
  };

  const unlink = () => {
    setBusyId(existingLink?.tracker_media_id ?? 'unlink');
    unlinkMangaFromTracker(manga.id, TRACKER)
      .then(() => {
        toast({ description: `Unlinked from ${TRACKER_LABEL}.` });
        onUnlinked();
      })
      .catch((error) => toast({ description: errorMessage(error, "Couldn't unlink — try again.") }))
      .finally(() => setBusyId(null));
  };

  if (existingLink) {
    return (
      <div className="space-y-4">
        <p className="text-xs text-muted-foreground">
          This title is linked to {TRACKER_LABEL}. Reading progress and status sync automatically;
          rate it below to sync your score too.
        </p>
        <ScoreControl manga={manga} />
        <SyncStatus link={existingLink} />
        <button
          onClick={unlink}
          disabled={busyId !== null}
          className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs font-medium text-destructive transition hover:bg-destructive/20 disabled:opacity-50"
        >
          {busyId ? '…' : 'Unlink'}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && runSearch()}
          className="h-8 text-xs"
          placeholder={`Search ${TRACKER_LABEL}…`}
        />
        <button
          onClick={runSearch}
          disabled={searching || !query.trim()}
          className="shrink-0 rounded-lg border border-border/60 px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-accent disabled:opacity-50"
        >
          {searching ? '…' : 'Search'}
        </button>
      </div>

      <div className="max-h-72 space-y-1 overflow-y-auto">
        {results.map((result) => (
          <div
            key={result.tracker_media_id}
            className="flex items-center justify-between gap-3 rounded-lg border border-border/50 px-3 py-2"
          >
            <span className="min-w-0 truncate text-xs text-foreground">{result.title}</span>
            <button
              onClick={() => link(result.tracker_media_id)}
              disabled={busyId !== null}
              className="shrink-0 rounded-lg border border-border/60 px-2.5 py-1 text-xs font-medium text-foreground transition hover:bg-accent disabled:opacity-50"
            >
              {busyId === result.tracker_media_id ? '…' : 'Link'}
            </button>
          </div>
        ))}
        {!searching && results.length === 0 && (
          <p className="px-1 text-xs text-muted-foreground">
            Search for a match to link this title.
          </p>
        )}
      </div>
    </div>
  );
}

/** Only rendered once the reader is signed in with AniList connected; anyone else has
 * nothing to link to, so a button would be a dead end. */
export function TrackerLinkButton({ manga }: { manga: Manga }) {
  const { user } = useCurrentUser();
  const userId = user?.id ?? null;
  const [connection, setConnection] = useState<{ userId: string; connected: boolean } | null>(null);
  const [linkLookup, setLinkLookup] = useState<{
    userId: string;
    mangaId: string;
    link: TrackerLink | null;
  } | null>(null);
  const [openFor, setOpenFor] = useState<string | null>(null);

  useEffect(() => {
    if (!userId) return;
    const controller = new AbortController();
    getConnectedTrackers(controller.signal)
      .then((trackers) => {
        if (!controller.signal.aborted)
          setConnection({ userId, connected: trackers.some((t) => t.tracker === TRACKER) });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          toast({ description: errorMessage(error, 'Could not check tracker connection.') });
      });
    return () => controller.abort();
  }, [userId]);

  useEffect(() => {
    if (!userId || connection?.userId !== userId || !connection.connected) return;
    const controller = new AbortController();
    getMangaTrackerLinks(manga.id, controller.signal)
      .then((links) => {
        if (!controller.signal.aborted)
          setLinkLookup({
            userId,
            mangaId: manga.id,
            link: links.find((l) => l.tracker === TRACKER) ?? null,
          });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          toast({ description: errorMessage(error, 'Could not load tracker link.') });
      });
    return () => controller.abort();
  }, [userId, connection, manga.id]);

  if (
    !userId ||
    connection?.userId !== userId ||
    !connection.connected ||
    linkLookup?.userId !== userId ||
    linkLookup.mangaId !== manga.id
  ) {
    return null;
  }
  const existingLink = linkLookup.link;
  const dialogKey = `${userId}\0${manga.id}`;

  return (
    <Dialog
      open={openFor === dialogKey}
      onOpenChange={(open) => setOpenFor(open ? dialogKey : null)}
    >
      <DialogTrigger asChild>
        <button
          aria-pressed={!!existingLink}
          aria-label={existingLink ? `Linked to ${TRACKER_LABEL}` : `Link to ${TRACKER_LABEL}`}
          title={existingLink ? `Linked to ${TRACKER_LABEL}` : `Link to ${TRACKER_LABEL}`}
          className={`grid h-10 w-10 place-items-center rounded-full border transition ${
            existingLink
              ? 'border-primary/50 bg-primary/10 text-primary'
              : 'border-border/60 bg-surface/60 text-foreground hover:bg-surface'
          }`}
        >
          <Link2 className="h-4 w-4" />
        </button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{TRACKER_LABEL}</DialogTitle>
          <DialogDescription>Link {manga.title} to sync reading progress.</DialogDescription>
        </DialogHeader>
        <LinkDialogBody
          manga={manga}
          existingLink={existingLink}
          onLinked={(link) => {
            setLinkLookup({ userId, mangaId: manga.id, link });
            setOpenFor(null);
          }}
          onUnlinked={() => {
            setLinkLookup({ userId, mangaId: manga.id, link: null });
            setOpenFor(null);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
