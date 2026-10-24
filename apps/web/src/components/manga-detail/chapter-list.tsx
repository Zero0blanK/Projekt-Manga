'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { toast } from '@/hooks/use-toast';
import {
  getMangaChapters,
  markChapterAsRead,
  markChapterAsUnread,
  markPreviousChaptersAsRead,
  markPreviousChaptersAsUnread,
  initiateDownload,
  getAllDownloads,
  type MangaChapterRecord,
  type ChapterBulkPayload,
} from '@projekt-manga/api-client';
import { invalidateSavedReadingProgress, queryClient, queryKeys } from '@/lib/query-client';
import { useCoarsePointer } from '@/lib/use-coarse-pointer';
import type { PublicUser } from '@projekt-manga/api-client';
import {
  formatRelative,
  knownGroup,
  passesChapterStatusFilter,
  type Manga,
} from '@/lib/manga-data';
import { SortDirectionIcon, type SortDirection } from '@/components/sort-direction-toggle';
import { ChapterListSkeleton } from '@/components/skeletons';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Play,
  Download,
  Eye,
  EyeOff,
  CheckCheck,
  CheckCircle2,
  ListX,
  Link2,
  Search,
  X,
  ChevronDown,
  ArrowUpDown,
  RefreshCw,
} from 'lucide-react';
import { refreshDownloads } from '@/components/downloads/row-data';
import {
  useChapterListVersion,
  useMangaUpdateCheck,
  useCheckOnManualReload,
} from '@/lib/manga-updates';
import { reportError } from '@/lib/report-error';
import { copyToClipboard } from '@/lib/clipboard';
import { copySourceChapterLink } from '@/lib/source-url';
import { useHoldToSelect } from '@/hooks/use-hold-to-select';
import { useChapterWindow } from '@/lib/chapter-window';
import { useChapterBookmarks } from '@/lib/chapter-bookmarks';
import { useChapterFilterScroll } from '@/lib/chapter-filter-scroll';
import { useCurrentUser } from '@/lib/session-resource';
import { useNewSinceLastVisit } from '@/lib/chapter-visits';

type ChapterRow = {
  id: string;
  n: number;
  title: string;
  read: boolean;
  date: string;
  group: string;
  /** Last page read, when partway through — the reader link jumps straight there. */
  lastPage: number;
  /** Real page total, or 0 when the source never reported one. */
  pageCount: number;
  /** The chapter's address on the source site; may be site-relative. */
  url: string;
};

function ChapterListItem({
  manga,
  chapter,
  downloaded,
  isNew,
  onToggleRead,
  onMarkPrevious,
  selected,
  onSelect,
  bookmarked,
  onBookmark,
  selectionMode,
  onDownload,
  onNavigate,
  index,
  total,
}: {
  manga: Manga;
  chapter: ChapterRow;
  downloaded: boolean;
  /** Arrived since the last time this title was opened. */
  isNew: boolean;
  onToggleRead: (chapter: ChapterRow) => void;
  onMarkPrevious: (chapter: ChapterRow, read: boolean) => void;
  selected: boolean;
  onSelect: () => void;
  bookmarked: boolean;
  onBookmark: () => void;
  selectionMode: boolean;
  onDownload: () => void;
  onNavigate: (event: React.KeyboardEvent<HTMLElement>, index: number) => void;
  index: number;
  total: number;
}) {
  const c = chapter;
  const progress = chapterProgressLabel(c);
  const hold = useHoldToSelect({ onSelect });

  return (
    <ContextMenu modal={false}>
      <ContextMenuTrigger asChild>
        <li
          aria-setsize={total}
          aria-posinset={index + 1}
          className={`flex h-[72px] items-center ${selected ? 'bg-primary/15 ring-1 ring-inset ring-primary/40' : 'transition-colors hover:bg-accent'}`}
        >
          <button
            type="button"
            aria-label={`${bookmarked ? 'Unbookmark' : 'Bookmark'} chapter ${c.n} ${c.group}`}
            aria-pressed={bookmarked}
            onClick={onBookmark}
            // 36px tap target; the bare star glyph is too small to press reliably.
            className="ml-1.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg text-sm text-primary hover:bg-accent focus-visible:outline-2 focus-visible:outline-primary"
          >
            {bookmarked ? '★' : '☆'}
          </button>
          <Link
            {...hold}
            href={readerHref(manga.id, c)}
            data-chapter-index={index}
            // The visible title (and group) belong in the name too: "Chapter 3" alone hid
            // which release a screen-reader user was about to open.
            aria-label={`Chapter ${c.n}${c.title && c.title !== `Chapter ${c.n}` ? `: ${c.title}` : ''}${c.group ? `, ${c.group}` : ''}${isNew ? ', new' : ''}${progress ? `, ${progress}` : ''}${selectionMode ? (selected ? ', selected' : ', select') : ', hold or press Space to select'}`}
            onKeyDown={(event) => {
              hold.onKeyDown(event);
              onNavigate(event, index);
            }}
            onClick={(event) => {
              if (selectionMode) {
                event.preventDefault();
                onSelect();
              }
            }}
            className={`flex h-full min-w-0 flex-1 items-center gap-4 px-4 py-3 ${selected ? '' : 'group'}`}
          >
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-background text-xs font-semibold tabular-nums text-muted-foreground group-hover:text-primary">
              {c.n}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-foreground">{c.title}</div>
              <div className="text-[11px] text-muted-foreground">
                {c.date}
                {c.group && ` · ${c.group}`}
              </div>
            </div>
            {isNew && !c.read && (
              <span
                title="New since your last visit"
                className="shrink-0 rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary-foreground"
              >
                New
              </span>
            )}
            {downloaded && (
              <span
                title="Downloaded for offline reading"
                className="flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary"
              >
                <CheckCircle2 className="h-3 w-3" /> Offline
              </span>
            )}
            {progress && (
              <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium tabular-nums text-primary">
                {progress}
              </span>
            )}
            {c.read && (
              <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                Read
              </span>
            )}
            <Play className="h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition group-hover:text-primary group-hover:opacity-100" />
          </Link>
        </li>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {c.read ? (
          <ContextMenuItem onSelect={() => onToggleRead(c)}>
            <EyeOff className="mr-2 h-3.5 w-3.5" /> Mark as unread
          </ContextMenuItem>
        ) : (
          <ContextMenuItem onSelect={() => onToggleRead(c)}>
            <Eye className="mr-2 h-3.5 w-3.5" /> Mark as read
          </ContextMenuItem>
        )}
        <ContextMenuItem onSelect={() => onMarkPrevious(c, true)}>
          <CheckCheck className="mr-2 h-3.5 w-3.5" /> Mark previous as read
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onMarkPrevious(c, false)}>
          <ListX className="mr-2 h-3.5 w-3.5" /> Mark previous as unread
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onDownload}>
          <Download className="mr-2 h-3.5 w-3.5" /> Download{' '}
          {selected && selectionMode ? 'selected chapters' : 'chapter'}
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() =>
            void copySourceChapterLink({ url: c.url, chapterNumber: c.n }, manga.source)
          }
        >
          <Link2 className="mr-2 h-3.5 w-3.5" /> Copy link
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

const STATUS_FILTERS = ['All', 'Unread', 'Read', 'Downloaded', 'Bookmarked'] as const;

const SORTS = [
  { value: 'latest', label: 'Latest first' },
  { value: 'chronological', label: 'Chronological' },
  { value: 'scanlation', label: 'Scanlation order' },
] as const;
type SortMode = (typeof SORTS)[number]['value'];

function toRow(c: MangaChapterRecord): ChapterRow {
  return {
    id: c.id,
    n: c.chapter_number,
    title: c.name || `Chapter ${c.chapter_number}`,
    read: c.is_read,
    date: formatRelative(c.release_date ?? c.fetched_at ?? c.created_at),
    group: knownGroup(c.scanlator),
    lastPage: c.last_page_read,
    pageCount: c.page_count ?? 0,
    url: c.url,
  };
}

/** Keep a saved position visible even when a pre-library placeholder lacked page count. */
function chapterProgressLabel(c: ChapterRow): string | null {
  if (c.read || c.lastPage <= 0) return null;
  return c.pageCount >= c.lastPage ? `${c.lastPage} / ${c.pageCount}` : `Page ${c.lastPage}`;
}

function readerHref(mangaId: string, chapter: ChapterRow): string {
  const page = !chapter.read && chapter.lastPage > 0 ? `&page=${chapter.lastPage}` : '';
  return `/reader/${mangaId}?ch=${chapter.n}${page}&chapterId=${encodeURIComponent(chapter.id)}`;
}

export function ChapterList({ manga }: { manga: Manga }) {
  const coarsePointer = useCoarsePointer();
  const { user, loading: sessionLoading } = useCurrentUser();
  const owner = user?.id ?? 'anonymous';
  const [recordsOwner, setRecordsOwner] = useState<string | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    setSelected([]);
    setBatchBusy(false);
    return () => {
      generation.current += 1;
    };
  }, [owner, manga.id]);
  const [records, setRecords] = useState<MangaChapterRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [chapterError, setChapterError] = useState(false);
  const [chapterRetry, setChapterRetry] = useState(0);
  /** Chapter ids with a completed download, for the "Offline" badge. */
  const [downloadedIds, setDownloadedIds] = useState<Set<string>>(new Set());
  const [excludedDownloadIds, setExcludedDownloadIds] = useState<Set<string>>(new Set());
  const [downloadsAvailable, setDownloadsAvailable] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const { isBookmarked, toggle: toggleBookmark } = useChapterBookmarks(records);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<(typeof STATUS_FILTERS)[number]>('All');
  const [group, setGroup] = useState<string>('All');
  const [sort, setSort] = useState<SortMode>('latest');
  const [sortDir, setSortDir] = useState<SortDirection>('desc');
  const [batchBusy, setBatchBusy] = useState(false);
  useEffect(() => {
    const clear = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !batchBusy) setSelected([]);
    };
    window.addEventListener('keydown', clear);
    return () => window.removeEventListener('keydown', clear);
  }, [batchBusy]);
  // Bumped by a per-title update check that actually found chapters — re-reading on that
  // signal beats polling for a change that is usually not there.
  const updateVersion = useChapterListVersion(manga.id);
  const { checking } = useMangaUpdateCheck(manga);

  // Reloading a title's page checks its source for new chapters. It's the chapter list
  // that changes as a result, so the status lives here — and it says something either
  // way, because a silent multi-second scrape that finds nothing is indistinguishable
  // from the reload having done nothing at all.
  useCheckOnManualReload(manga, {
    enabled: manga.inLibrary,
    onResult: (found, error) =>
      toast(
        error
          ? {
              variant: 'destructive',
              description: `Couldn't check ${manga.title} for new chapters.`,
            }
          : found > 0
            ? {
                title: `${found} new chapter${found === 1 ? '' : 's'}`,
                description: `Added to ${manga.title}.`,
              }
            : {
                description: `${manga.title} checked — no new chapters. If the source was unreachable, the reason is in Notifications › Update log.`,
              },
      ),
  });

  useEffect(() => {
    if (sessionLoading) return;
    const controller = new AbortController();
    setChapterError(false);
    // Not reset to true on a re-check (updateVersion bump) — the list already has
    // records on screen at that point, and flashing back to skeletons over a re-read
    // would be a worse experience than briefly showing the pre-update list.
    getMangaChapters(manga.id, manga.slug, manga.source, controller.signal)
      .then((rows) => {
        if (!controller.signal.aborted) {
          setRecords(rows);
          setRecordsOwner(owner);
        }
      })
      // An empty list otherwise reads as "this title has no chapters".
      .catch((error) => {
        if (!controller.signal.aborted) {
          setChapterError(true);
          setRecords([]);
          setRecordsOwner(owner);
          reportError(error, "Couldn't load chapters for this title.");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [manga.id, manga.slug, manga.source, updateVersion, owner, sessionLoading, chapterRetry]);

  // One list call rather than a per-chapter "is downloaded?" check, which would be an
  // N+1 against a chapter list that can run to hundreds of rows.
  useEffect(() => {
    if (sessionLoading) return;
    const controller = new AbortController();
    setDownloadsAvailable(false);
    setExcludedDownloadIds(new Set());
    setDownloadedIds(new Set());
    getAllDownloads(controller.signal)
      .then((all) => {
        if (controller.signal.aborted) return;
        setDownloadsAvailable(true);
        setExcludedDownloadIds(
          new Set(
            all
              .filter((download) => download.status !== 'FAILED')
              .map((download) => download.chapter_id),
          ),
        );
        setDownloadedIds(
          new Set(
            all.filter((d) => d.status === 'COMPLETED' && d.chapter_id).map((d) => d.chapter_id),
          ),
        );
      })
      .catch(() => {
        if (!controller.signal.aborted) setDownloadsAvailable(false);
      });
    return () => controller.abort();
  }, [manga.id, owner, sessionLoading]);

  const chapters: ChapterRow[] =
    !sessionLoading && recordsOwner === owner ? records.map(toRow) : [];
  const newIds = useNewSinceLastVisit(
    owner,
    manga.id,
    chapters.map((c) => c.id),
    // Only library titles have a stable chapter list worth comparing between visits.
    manga.inLibrary && !loading && !chapterError,
  );
  const newUnread = chapters.filter((c) => newIds.has(c.id) && !c.read).length;

  const onToggleRead = (c: ChapterRow) => {
    if (
      batchBusy ||
      sessionLoading ||
      (queryClient.getQueryData<PublicUser | null>(queryKeys.session)?.id ?? 'anonymous') !== owner
    )
      return;
    const requestGeneration = generation.current;
    const mutate = c.read ? markChapterAsUnread : markChapterAsRead;
    setRecords((prev) => prev.map((r) => (r.id === c.id ? { ...r, is_read: !c.read } : r)));
    mutate(manga.slug, c.id, { source: manga.source })
      .then(invalidateSavedReadingProgress)
      .catch(() => {
        if (generation.current !== requestGeneration) return;
        setRecords((prev) => prev.map((r) => (r.id === c.id ? { ...r, is_read: c.read } : r)));
        toast({ description: "Couldn't update chapter — try again" });
      });
  };

  /** "Previous" is inclusive of the chapter you right-clicked, matching how readers think
   * about it ("I've read up to here"). Only chapters that would actually change are sent,
   * so marking previous-as-read over an already-read run is a no-op rather than a burst of
   * redundant writes. */
  const onMarkPrevious = (c: ChapterRow, read: boolean) => {
    const requestGeneration = generation.current;
    const targets = records.filter((r) => r.chapter_number <= c.n && r.is_read !== read);
    if (targets.length === 0) {
      toast({
        description: read
          ? 'Everything up to here is already read'
          : 'Everything up to here is already unread',
      });
      return;
    }
    const previous = records;
    setRecords((prev) => prev.map((r) => (r.chapter_number <= c.n ? { ...r, is_read: read } : r)));
    // Only the fields the server needs to create the row if it doesn't exist yet
    // (ensureChapterExists) plus `source` — the target read/unread state itself is the
    // `read` flag chosen above, via markPreviousChaptersAsRead/Unread, not anything on
    // the payload.
    const payload: ChapterBulkPayload[] = targets.map((r) => ({
      id: r.id,
      name: r.name ?? undefined,
      url: r.url,
      scanlator: r.scanlator ?? undefined,
      chapter_number: r.chapter_number,
      last_page_read: r.last_page_read,
      page_count: r.page_count ?? undefined,
      fetched_at: r.fetched_at ?? undefined,
      release_date: r.release_date ?? undefined,
      source: manga.source,
    }));
    const mutate = read ? markPreviousChaptersAsRead : markPreviousChaptersAsUnread;
    mutate(manga.slug, payload, {
      manga_id: manga.id,
      title: manga.title,
    })
      .then((result) => {
        if (generation.current !== requestGeneration) return;
        invalidateSavedReadingProgress();
        if (result.failed_chapter_ids.length > 0) {
          const failed = new Set(result.failed_chapter_ids);
          setRecords((current) =>
            current.map((row) =>
              failed.has(row.id) ? (previous.find((old) => old.id === row.id) ?? row) : row,
            ),
          );
        }
        toast({
          description:
            result.failed_chapter_ids.length > 0
              ? `Updated ${result.count} chapters; ${result.failed_chapter_ids.length} failed`
              : `Marked ${targets.length} chapter${targets.length === 1 ? '' : 's'} as ${read ? 'read' : 'unread'}`,
        });
      })
      .catch(() => {
        if (generation.current !== requestGeneration) return;
        setRecords(previous);
        toast({ description: "Couldn't mark previous chapters — try again" });
      });
  };

  const allGroups = Array.from(new Set(chapters.map((c) => c.group).filter(Boolean))).sort();

  const q = query.trim().toLowerCase();
  const filtered = chapters.filter((c) => {
    if (
      status === 'Downloaded'
        ? !downloadedIds.has(c.id)
        : status === 'Bookmarked'
          ? !isBookmarked(c.id)
          : !passesChapterStatusFilter(c.read, status)
    )
      return false;
    if (group !== 'All' && c.group !== group) return false;
    if (q && !String(c.n).includes(q) && !c.title.toLowerCase().includes(q)) return false;
    return true;
  });

  const compare = (a: ChapterRow, b: ChapterRow) => {
    if (sort === 'chronological') return a.n - b.n;
    if (sort === 'scanlation') {
      return a.group === b.group ? b.n - a.n : a.group.localeCompare(b.group);
    }
    return b.n - a.n;
  };
  const flip = sortDir === 'asc' ? -1 : 1;
  const sorted = [...filtered].sort((a, b) => flip * compare(a, b));
  const filterKey = JSON.stringify([q, status, group, sort, sortDir]);
  useChapterFilterScroll(filterKey);
  const chapterWindow = useChapterWindow(
    sorted.length,
    filterKey + (selected.length ? ':selection' : ':browse'),
  );
  const visibleChapters = sorted.slice(chapterWindow.start, chapterWindow.end);
  const batch = async (action: 'download' | 'read' | 'unread', fallback?: ChapterRow) => {
    if (batchBusy || sessionLoading) return;
    const version = generation.current;
    const current = () =>
      generation.current === version &&
      (queryClient.getQueryData<PublicUser | null>(queryKeys.session)?.id ?? 'anonymous') === owner;
    if (!current()) return;
    const ids = new Set(
      fallback && !selected.includes(fallback.id) ? [fallback.id] : selected.length ? selected : [],
    );
    const targets = chapters.filter((c) => ids.has(c.id));
    if (!targets.length) return;
    setBatchBusy(true);
    const failed: string[] = [];
    try {
      for (const c of targets) {
        if (!current()) return;
        try {
          if (action === 'download') {
            if (!downloadsAvailable) {
              failed.push(c.id);
              continue;
            }
            if (excludedDownloadIds.has(c.id)) continue;
            await initiateDownload({
              sourceId: manga.source,
              mangaSlug: manga.slug,
              mangaTitle: manga.title,
              chapter: { id: c.id, name: c.title, chapter_number: c.n },
            });
            if (current()) setExcludedDownloadIds((existing) => new Set(existing).add(c.id));
          } else {
            const read = action === 'read';
            await (read ? markChapterAsRead : markChapterAsUnread)(manga.slug, c.id, {
              source: manga.source,
            });
            if (current())
              setRecords((existing) =>
                existing.map((row) =>
                  row.id === c.id
                    ? { ...row, is_read: read, ...(read ? {} : { last_page_read: 0 }) }
                    : row,
                ),
              );
          }
        } catch {
          failed.push(c.id);
        }
      }
      if (current()) {
        setSelected(failed);
        refreshDownloads();
        invalidateSavedReadingProgress();
        toast({
          description: failed.length
            ? `${failed.length} chapters could not be processed. They remain selected for retry.`
            : action === 'download'
              ? 'Selected chapters queued for download.'
              : 'Selected chapters updated.',
        });
      }
    } finally {
      if (current()) setBatchBusy(false);
    }
  };

  return (
    <div className="mt-12">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex items-baseline gap-3">
          <h2 className="text-display text-2xl text-foreground">Chapters</h2>
          <span className="text-xs text-muted-foreground">
            {filtered.length === chapters.length
              ? `${chapters.length} total`
              : `${filtered.length} of ${chapters.length}`}
          </span>
          {newUnread > 0 && (
            <span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary">
              {newUnread} new since your last visit
            </span>
          )}
          {checking && (
            <span role="status" className="flex items-center gap-1.5 text-xs text-primary">
              <RefreshCw className="h-3 w-3 animate-spin" />
              Checking for new chapters…
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5 rounded-full border border-border/60 bg-surface/40 px-3 py-1.5 text-xs text-muted-foreground focus-within:border-primary/50">
            <Search className="h-3.5 w-3.5" />
            <input
              aria-label="Find a chapter"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find a chapter…"
              className="w-32 bg-transparent text-foreground outline-none placeholder:text-muted-foreground pointer-coarse:min-h-6"
            />
            {query && (
              <button
                onClick={() => setQuery('')}
                aria-label="Clear search"
                className="hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {STATUS_FILTERS.map((s) => (
            <button
              key={s}
              onClick={() => setStatus(s)}
              aria-pressed={status === s}
              // `border-transparent` rather than no border keeps the selected pill the same
              // height as its neighbours.
              className={`rounded-full border px-3.5 py-1.5 text-xs font-medium transition ${
                status === s
                  ? 'border-transparent bg-primary text-primary-foreground shadow-glow'
                  : 'border-border/60 bg-surface/40 text-muted-foreground hover:border-border hover:text-foreground'
              }`}
            >
              {s}
            </button>
          ))}

          {allGroups.length > 1 && (
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger className="flex items-center gap-1.5 rounded-full border border-border/60 bg-surface/40 px-3 py-1.5 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary">
                {group === 'All' ? 'All groups' : group}
                <ChevronDown className="h-3.5 w-3.5 opacity-50" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onSelect={() => setGroup('All')}
                  className={group === 'All' ? 'text-primary' : ''}
                >
                  All groups
                </DropdownMenuItem>
                {allGroups.map((g) => (
                  <DropdownMenuItem
                    key={g}
                    onSelect={() => setGroup(g)}
                    className={group === g ? 'text-primary' : ''}
                  >
                    {g}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          <DropdownMenu modal={false}>
            <DropdownMenuTrigger className="flex items-center gap-1.5 rounded-full border border-border/60 bg-surface/40 px-3 py-1.5 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary">
              <ArrowUpDown className="h-3.5 w-3.5" />
              {SORTS.find((s) => s.value === sort)?.label}
              <ChevronDown className="h-3.5 w-3.5 opacity-50" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {SORTS.map((s) => {
                const active = sort === s.value;
                return (
                  <DropdownMenuItem
                    key={s.value}
                    onSelect={(e) => {
                      e.preventDefault();
                      if (active) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
                      else {
                        setSort(s.value);
                        setSortDir('desc');
                      }
                    }}
                    className={`flex items-center justify-between ${active ? 'text-primary' : ''}`}
                  >
                    {s.label}
                    {active && <SortDirectionIcon direction={sortDir} />}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {selected.length > 0 ? (
        <div
          className="sticky top-36 z-20 mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-primary/30 bg-background/95 p-3 text-xs shadow-lg backdrop-blur sm:top-24"
          role="toolbar"
          aria-label="Selected chapter actions"
        >
          <span role="status" className="font-semibold">
            {selected.length} selected
          </span>
          <button
            disabled={batchBusy || !downloadsAvailable}
            onClick={() => void batch('download')}
            className="inline-flex items-center gap-1 text-primary disabled:opacity-40"
          >
            <Download size={14} />
            Download
          </button>
          <button disabled={batchBusy} onClick={() => void batch('read')} className="text-primary">
            Mark read
          </button>
          <button
            disabled={batchBusy}
            onClick={() => void batch('unread')}
            className="text-primary"
          >
            Mark unread
          </button>
          <button type="button" disabled={batchBusy} onClick={() => setSelected([])}>
            Clear selection ({selected.length})
          </button>
        </div>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">
          {coarsePointer
            ? 'Long-press a chapter to select it.'
            : 'Hold a chapter or press Space to select. Right-click for actions.'}
        </p>
      )}
      {chapterError && recordsOwner === owner ? (
        <p role="alert" className="mt-4 text-sm text-destructive">
          Chapters could not be loaded.{' '}
          <button
            type="button"
            onClick={() => setChapterRetry((current) => current + 1)}
            className="underline"
          >
            Try again
          </button>
        </p>
      ) : (loading || sessionLoading || recordsOwner !== owner) && chapters.length === 0 ? (
        <ChapterListSkeleton />
      ) : sorted.length === 0 ? (
        <div className="mt-4 rounded-xl border border-dashed border-border/60 p-8 text-center text-sm text-muted-foreground">
          No chapters match your filters.
        </div>
      ) : (
        <ul
          ref={chapterWindow.ref}
          className="mt-4 divide-y divide-border/50 overflow-hidden rounded-xl border border-border/60 bg-surface/40"
          aria-label="Chapters"
        >
          {chapterWindow.top > 0 && <li aria-hidden="true" style={{ height: chapterWindow.top }} />}
          {visibleChapters.map((c, index) => (
            <ChapterListItem
              key={c.id}
              manga={manga}
              chapter={c}
              downloaded={downloadedIds.has(c.id)}
              isNew={newIds.has(c.id)}
              onToggleRead={(chapter) => {
                if (selected.includes(chapter.id) && selected.length > 1)
                  void batch(chapter.read ? 'unread' : 'read');
                else onToggleRead(chapter);
              }}
              onMarkPrevious={onMarkPrevious}
              selected={selected.includes(c.id)}
              onSelect={() =>
                !batchBusy &&
                setSelected((current) =>
                  current.includes(c.id) ? current.filter((id) => id !== c.id) : [...current, c.id],
                )
              }
              bookmarked={isBookmarked(c.id)}
              onBookmark={() => toggleBookmark(c.id)}
              selectionMode={selected.length > 0}
              onDownload={() => void batch('download', c)}
              index={chapterWindow.start + index}
              total={sorted.length}
              onNavigate={chapterWindow.onKeyDown}
            />
          ))}
          {chapterWindow.bottom > 0 && (
            <li aria-hidden="true" style={{ height: chapterWindow.bottom }} />
          )}
        </ul>
      )}
    </div>
  );
}
