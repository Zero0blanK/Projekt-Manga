'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { getHistory, type HistoryEntry } from '@projekt-manga/api-client';
import type { Manga } from '@/lib/manga-data';
import { useMangaLibrary, useLibraryState } from '@/lib/library-store';
import { useAppState } from '@/lib/app-store';
import { filters, shelfOf as resolveShelf } from '@/components/library/constants';
import { FilterPills } from '@/components/library/filter-pills';
import { ViewToggle } from '@/components/library/view-toggle';
import { SortMenu } from '@/components/library/sort-menu';
import { UpdateLibraryButton } from '@/components/library/update-library-button';
import { ContinueReadingHero } from '@/components/library/continue-reading-hero';
import { LibraryGrid } from '@/components/library/library-grid';
import { useDownloadRows } from '@/components/downloads/row-data';
import { RecentlyUpdatedRail } from '@/components/library/recently-updated-rail';
import { EmptyState } from '@/components/page-shell';
import { MangaGridSkeleton } from '@/components/skeletons';
import { mostRecentlyReadLibraryManga } from '@/lib/recent-reading';
import { LibrarySelectionBar, parseDensity } from '@/components/library/library-tools';
import { useProfilePreference } from '@/lib/profile-preferences';
import { Download, Eye } from 'lucide-react';
import { useCurrentUser } from '@/lib/session-resource';

export function LibraryPageClient() {
  const [filter, setFilter] = useState<string>('all');
  const [historyRows, setHistory] = useState<HistoryEntry[] | null>(null);
  const [historyOwner, setHistoryOwner] = useState<string | null>(null);
  const { user, loading: sessionLoading } = useCurrentUser();
  const owner = user?.id ?? 'anonymous';
  const history = historyOwner === owner && !sessionLoading ? historyRows : null;
  const [selected, setSelected] = useState<string[]>([]);
  const [actionsRequest, setActionsRequest] = useState(0);
  const [density] = useProfilePreference('library-density', parseDensity, 'comfortable');

  useEffect(() => {
    setHistory(null);
    if (sessionLoading) return;
    const controller = new AbortController();
    getHistory(controller.signal)
      .then((rows) => {
        if (!controller.signal.aborted) {
          setHistory(rows);
          setHistoryOwner(owner);
        }
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        // History only chooses the featured card; the library itself is still usable.
        setHistory([]);
        setHistoryOwner(owner);
      });
    return () => controller.abort();
  }, [owner, sessionLoading]);

  const sort = useAppState((s) => s.sort);
  const sortDir = useAppState((s) => s.sortDir);
  const view = useAppState((s) => s.view);
  const categoryMembers = useAppState((s) => s.categoryMembers);
  const { manga: mangaLibrary, loading, refresh } = useMangaLibrary();
  const { shelf, bookmarks } = useLibraryState();

  const shelfOf = (m: Manga) => resolveShelf(m, shelf);
  const progressOf = (m: Manga) => m.progress ?? 0;

  const reading = mangaLibrary.filter((m) => shelfOf(m) === 'reading');

  const isShelfFilter = filter === 'all' || filters.some((f) => f.value === filter);

  // When each title was last opened, for the "Last Read" sort. Titles never read sort last.
  const lastReadAt = useMemo(() => {
    const map = new Map<string, number>();
    for (const entry of history ?? []) {
      if (!entry.manga_id) continue;
      const parsed = Date.parse(entry.last_read);
      const at = Number.isFinite(parsed) ? parsed : Date.parse(entry.read_at);
      if (Number.isFinite(at) && at > (map.get(entry.manga_id) ?? -Infinity))
        map.set(entry.manga_id, at);
    }
    return map;
  }, [history]);

  // Quick filters that combine with the shelf/category pills.
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [onlyDownloaded, setOnlyDownloaded] = useState(false);
  const { completed: completedDownloads } = useDownloadRows();
  const downloadedIds = useMemo(
    () => new Set(completedDownloads.map((row) => row.mangaId)),
    [completedDownloads],
  );
  const unreadOf = (m: Manga) =>
    Math.max(0, m.chapters - Math.round((m.progress ?? 0) * m.chapters));

  const visible = useMemo(() => {
    const list = mangaLibrary.filter((m) => {
      if (onlyUnread && unreadOf(m) === 0) return false;
      if (onlyDownloaded && !downloadedIds.has(m.id)) return false;
      if (isShelfFilter) return filter === 'all' || shelfOf(m) === filter;
      return (categoryMembers[filter] ?? []).includes(m.id);
    });
    const sorted = [...list];
    const compare = (a: Manga, b: Manga) => {
      if (sort === 'title') return a.title.localeCompare(b.title);
      if (sort === 'rating') return (b.rating ?? 0) - (a.rating ?? 0);
      if (sort === 'progress') return progressOf(b) - progressOf(a);
      if (sort === 'lastRead')
        return (lastReadAt.get(b.id) ?? -Infinity) - (lastReadAt.get(a.id) ?? -Infinity);
      return +new Date(b.updatedAt) - +new Date(a.updatedAt);
    };
    const flip = sortDir === 'asc' ? -1 : 1;
    sorted.sort((a, b) => flip * compare(a, b));
    return sorted;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    mangaLibrary,
    filter,
    isShelfFilter,
    sort,
    sortDir,
    shelf,
    categoryMembers,
    lastReadAt,
    onlyUnread,
    onlyDownloaded,
    downloadedIds,
  ]);

  const featured =
    history === null
      ? null
      : (mostRecentlyReadLibraryManga(history, mangaLibrary) ?? reading[0] ?? mangaLibrary[0]);
  const recentRead =
    featured && history
      ? history.reduce<HistoryEntry | null>((latest, entry) => {
          if (
            entry.manga_id !== featured.id &&
            (entry.source !== featured.source || entry.manga_slug !== featured.slug)
          )
            return latest;
          const parsed = Date.parse(entry.last_read);
          const timestamp = Number.isFinite(parsed) ? parsed : Date.parse(entry.read_at);
          const previous = latest ? Date.parse(latest.last_read) : -Infinity;
          const latestTimestamp = Number.isFinite(previous)
            ? previous
            : latest
              ? Date.parse(latest.read_at)
              : -Infinity;
          return Number.isFinite(timestamp) && timestamp > latestTimestamp ? entry : latest;
        }, null)
      : null;

  return (
    <div className="flex min-w-0">
      <div className="min-w-0 flex-1 px-4 py-6 sm:px-8">
        <FilterPills filter={filter} onChange={setFilter} />

        <div className="mt-6 flex flex-wrap items-end justify-between gap-4 sm:mt-8">
          <div>
            <h1 className="text-display text-4xl leading-none text-foreground sm:text-5xl">
              My Library
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              <span className="text-foreground">{mangaLibrary.length}</span>{' '}
              {mangaLibrary.length === 1 ? 'title' : 'titles'} ·{' '}
              <span className="text-foreground">{reading.length}</span> in progress ·{' '}
              <Link
                href="/bookmarks"
                className="text-foreground underline decoration-border underline-offset-4 hover:text-primary"
              >
                {bookmarks.length} bookmarked
              </Link>
            </p>
          </div>
          <div className="-mx-4 flex max-w-[calc(100%+2rem)] items-center gap-2 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:max-w-full sm:flex-wrap sm:overflow-visible sm:px-0 [&::-webkit-scrollbar]:hidden [&>*]:shrink-0">
            <ViewToggle />
            <SortMenu />
            {/* Icon buttons matching ViewToggle/SortMenu so the toolbar reads as one row. With
                no visible text, each carries both an aria-label (screen readers) and a title
                (hover): aria-label alone shows nothing on hover, and title alone is not
                reliably announced. */}
            {(
              [
                ['Unread', 'Show only titles with unread chapters', Eye, onlyUnread, setOnlyUnread],
                [
                  'Downloaded',
                  'Show only titles with downloaded chapters',
                  Download,
                  onlyDownloaded,
                  setOnlyDownloaded,
                ],
              ] as const
            ).map(([label, description, Icon, on, set]) => (
              <button
                key={label}
                type="button"
                // Name is what the control is called, so "click Unread" works for voice
                // control and matches the word a reader would use for it; the longer
                // phrase becomes its description rather than its name.
                aria-label={label}
                aria-pressed={on}
                title={description}
                onClick={() => set(!on)}
                className={`grid h-9 w-9 place-items-center rounded-lg border transition ${
                  on
                    ? 'border-primary/50 bg-primary/10 text-primary'
                    : 'border-border/60 text-muted-foreground hover:text-foreground'
                }`}
              >
                <Icon className="h-4 w-4" />
              </button>
            ))}
            {/* With nothing in the library there is nothing to update; finding a first title
                is the one useful next step. */}
            {mangaLibrary.length > 0 ? (
              <UpdateLibraryButton />
            ) : (
              <Link
                href="/discover"
                className="rounded-full bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground"
              >
                Find manga
              </Link>
            )}
            <Link href="/local" className="rounded-full border border-border px-3 py-2 text-xs">
              Local CBZ collection
            </Link>
          </div>
        </div>

        {featured && <ContinueReadingHero manga={featured} recentRead={recentRead ?? undefined} />}

        <LibrarySelectionBar
          manga={mangaLibrary}
          visible={visible}
          selected={selected}
          setSelected={setSelected}
          refresh={refresh}
          actionsRequest={actionsRequest}
        />

        <div className="mt-10">
          <div className="mb-4 flex items-baseline justify-between">
            <h3 className="text-sm font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              {filters.find((f) => f.value === filter)?.label ?? filter} Titles
            </h3>
            <span className="text-xs text-muted-foreground">
              {loading ? 'Loading…' : `Showing ${visible.length}`}
            </span>
          </div>

          {loading && mangaLibrary.length === 0 ? (
            <MangaGridSkeleton />
          ) : !loading && mangaLibrary.length === 0 ? (
            <EmptyState>
              Your library is empty — add a title from{' '}
              <Link href="/discover" className="text-primary hover:opacity-80">
                Discover
              </Link>{' '}
              to get started.
            </EmptyState>
          ) : (
            <LibraryGrid
              manga={visible}
              view={view}
              onShowAll={() => setFilter('all')}
              selected={selected}
              onSelect={(id) => {
                if (!selected.length) setActionsRequest((value) => value + 1);
                setSelected((ids) =>
                  ids.includes(id) ? ids.filter((v) => v !== id) : [...ids, id],
                );
              }}
              onContextOpen={() => setSelected([])}
              density={density}
              resetKey={[filter, sort, sortDir, view, onlyUnread, onlyDownloaded].join('|')}
            />
          )}
        </div>
      </div>

      <RecentlyUpdatedRail />
    </div>
  );
}
