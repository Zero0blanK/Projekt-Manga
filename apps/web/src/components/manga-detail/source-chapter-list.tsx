'use client';

import { useEffect, useRef, useState } from 'react';
import { ChapterSelectionLink } from './chapter-selection-link';
import { useChapterWindow } from '@/lib/chapter-window';
import { useCoarsePointer } from '@/lib/use-coarse-pointer';
import type { Chapters } from '@projekt-manga/types';
import {
  markChapterAsRead,
  markChapterAsUnread,
  markPreviousChaptersAsRead,
  markPreviousChaptersAsUnread,
  addHistory,
  type ChapterBulkPayload,
  type HistoryEntry,
  getAllDownloads,
} from '@projekt-manga/api-client';
import { toast } from '@/hooks/use-toast';
import {
  formatRelative,
  knownGroup,
  passesChapterStatusFilter,
  sortByChapterNumber,
} from '@/lib/manga-data';
import { SortDirectionIcon, type SortDirection } from '@/components/sort-direction-toggle';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  Play,
  Download,
  Link2,
  Search,
  X,
  ArrowUpDown,
  ChevronDown,
  Eye,
  EyeOff,
  CheckCheck,
  ListX,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { copyToClipboard } from '@/lib/clipboard';
import { copySourceChapterLink } from '@/lib/source-url';
import { useChapterBookmarks } from '@/lib/chapter-bookmarks';
import { useChapterFilterScroll } from '@/lib/chapter-filter-scroll';
import { useCurrentUser } from '@/lib/session-resource';
import { queryClient, queryKeys } from '@/lib/query-client';
import type { PublicUser } from '@projekt-manga/api-client';

const STATUS_FILTERS = ['All', 'Unread', 'Read', 'Downloaded', 'Bookmarked'] as const;

/**
 * Chapter list for a title reached through a source. Mirrors the library list — same rows,
 * same right-click actions, same filters.
 *
 * Read state works here even with no library row: `chapter.manga_id` is nullable, and the
 * server's mark endpoints create the chapter from the payload when it doesn't exist yet
 * (`ensureChapterExists`), keying everything off source + slug. Each mark also writes a
 * history entry, so reading progress on a title you never added still shows up in History
 * and Recents.
 */
export function SourceChapterList({
  chapters,
  mangaSlug,
  sourceMangaId,
  sourceId,
  mangaTitle,
  thumbnailUrl,
  readChapterIds,
  chapterProgress,
  readerHref,
  onDownload,
  onReadChange,
}: {
  chapters: Chapters[];
  mangaSlug: string;
  sourceMangaId: string;
  sourceId: string;
  mangaTitle: string;
  thumbnailUrl?: string;
  /** Read chapter ids resolved by the parent, from the library row and from history. */
  readChapterIds: Set<string>;
  chapterProgress: Map<string, HistoryEntry>;
  readerHref: (chapterNumber: number) => string;
  onDownload: (chapter: { id: string; name?: string; chapter_number: number }) => Promise<unknown>;
  /** Lets the parent keep its own copy in step (it owns the initial fetch). */
  onReadChange?: (readIds: Set<string>) => void;
}) {
  const coarsePointer = useCoarsePointer();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<(typeof STATUS_FILTERS)[number]>('All');
  /** Scanlation group filter, matching the library chapter list. */
  const [group, setGroup] = useState('All');
  const [sortDir, setSortDir] = useState<SortDirection>('desc');
  const [selected, setSelected] = useState<string[]>([]);
  const [batchBusy, setBatchBusy] = useState(false);
  useEffect(() => {
    const clear = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !batchBusy) setSelected([]);
    };
    window.addEventListener('keydown', clear);
    return () => window.removeEventListener('keydown', clear);
  }, [batchBusy]);
  const [downloading, setDownloading] = useState<Set<string>>(new Set());
  const [downloadedIds, setDownloadedIds] = useState<Set<string>>(new Set());
  const [downloadsError, setDownloadsError] = useState(false);
  const { user, loading: sessionLoading } = useCurrentUser();
  const owner = user?.id ?? 'anonymous';
  const [downloadsOwner, setDownloadsOwner] = useState<string | null>(null);
  const { isBookmarked, toggle: toggleBookmark } = useChapterBookmarks(chapters);
  useEffect(() => {
    if (sessionLoading) return;
    const controller = new AbortController();
    setDownloadedIds(new Set());
    setDownloadsError(false);
    setDownloadsOwner(null);
    getAllDownloads(controller.signal)
      .then((downloads) => {
        if (controller.signal.aborted) return;
        setDownloadedIds(
          new Set(
            downloads
              .filter(
                (download) =>
                  download.source_id === sourceId &&
                  download.status === 'COMPLETED' &&
                  download.downloaded_path,
              )
              .map((download) => download.chapter_id),
          ),
        );
        setDownloadsError(false);
        setDownloadsOwner(owner);
      })
      .catch(() => {
        if (!controller.signal.aborted) setDownloadsError(true);
      });
    return () => controller.abort();
  }, [sourceId, mangaSlug, owner, sessionLoading]);
  const chapterHref = (chapter: Chapters) => {
    const href = new URL(readerHref(chapter.chapter_number), 'https://reader.invalid');
    href.searchParams.set('chapterId', chapter.id);
    return `${href.pathname}${href.search}${href.hash}`;
  };
  // Mirrors the prop so marks apply instantly; re-seeded whenever the parent's fetch lands.
  const [readIds, setReadIds] = useState<Set<string>>(readChapterIds);
  const readIdsRef = useRef(readChapterIds);
  const mutationVersion = useRef(0);
  const latestMutationForChapter = useRef(new Map<string, number>());
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    latestMutationForChapter.current.clear();
    setDownloading(new Set());
    setSelected([]);
    setBatchBusy(false);
    return () => {
      generation.current += 1;
    };
  }, [owner, sessionLoading, sourceId, mangaSlug]);
  const requestCurrent = (requestGeneration: number) =>
    !sessionLoading &&
    generation.current === requestGeneration &&
    (queryClient.getQueryData<PublicUser | null>(queryKeys.session)?.id ?? 'anonymous') === owner;

  useEffect(() => {
    readIdsRef.current = readChapterIds;
    setReadIds(readChapterIds);
  }, [readChapterIds]);

  const applyRead = (next: Set<string>) => {
    readIdsRef.current = next;
    setReadIds(next);
    onReadChange?.(next);
  };

  /** The chapter fields the server needs to create the row if it doesn't exist yet, plus
   * `source` — the bulk endpoint only writes history when it knows which source to
   * attribute the read to. */
  const payloadFor = (c: Chapters): ChapterBulkPayload => ({
    id: c.id,
    name: c.name ?? undefined,
    url: c.url,
    scanlator: c.scanlator ?? undefined,
    chapter_number: c.chapter_number,
    release_date: c.release_date ?? undefined,
    page_count: c.page_count ?? undefined,
    source: sourceId,
  });

  const toggleRead = (c: Chapters) => {
    const requestGeneration = generation.current;
    if (!requestCurrent(requestGeneration)) return;
    const wasRead = readIdsRef.current.has(c.id);
    const next = new Set(readIdsRef.current);
    const version = ++mutationVersion.current;
    latestMutationForChapter.current.set(c.id, version);
    if (wasRead) next.delete(c.id);
    else next.add(c.id);
    applyRead(next);

    const mutate = wasRead ? markChapterAsUnread : markChapterAsRead;
    let saved = false;
    return mutate(mangaSlug, c.id, payloadFor(c))
      .then(() => {
        if (!requestCurrent(requestGeneration)) return;
        saved = true;
        // The single-chapter endpoints don't touch history, so record it here — carrying
        // the title and cover, which is the only way a title with no library row can show
        // up in History and Recents with something readable.
        if (!wasRead) {
          void addHistory({
            source: sourceId,
            manga_slug: mangaSlug,
            source_manga_id: sourceMangaId,
            title: mangaTitle,
            thumbnail_url: thumbnailUrl || undefined,
            chapter_id: c.id,
            pages_read: c.page_count || 0,
          }).catch(() => {
            if (requestCurrent(requestGeneration))
              toast({ description: 'Chapter marked read, but recent history could not be saved.' });
          });
        }
      })
      .catch(() => {
        if (!requestCurrent(requestGeneration)) return;
        // Restore only this request's chapter, and only while no newer action owns it.
        // Restoring a whole stale Set would erase successful concurrent marks.
        if (latestMutationForChapter.current.get(c.id) === version) {
          const rollback = new Set(readIdsRef.current);
          if (wasRead) rollback.add(c.id);
          else rollback.delete(c.id);
          applyRead(rollback);
        }
        toast({ description: "Couldn't update chapter — try again" });
      })
      .finally(() => {
        if (!requestCurrent(requestGeneration)) return;
        if (latestMutationForChapter.current.get(c.id) === version) {
          latestMutationForChapter.current.delete(c.id);
        }
      })
      .then(() => saved);
  };

  /** Inclusive of the chapter acted on, matching "I've read up to here". */
  const markPrevious = (c: Chapters, read: boolean) => {
    const requestGeneration = generation.current;
    if (!requestCurrent(requestGeneration)) return;
    const targets = chapters.filter(
      (other) =>
        other.chapter_number <= c.chapter_number && readIdsRef.current.has(other.id) !== read,
    );
    if (targets.length === 0) {
      toast({
        description: read
          ? 'Everything up to here is already read'
          : 'Everything up to here is already unread',
      });
      return;
    }

    const previousReadById = new Map(
      targets.map((target) => [target.id, readIdsRef.current.has(target.id)]),
    );
    const versions = new Map<string, number>();
    const next = new Set(readIdsRef.current);
    for (const target of targets) {
      const version = ++mutationVersion.current;
      versions.set(target.id, version);
      latestMutationForChapter.current.set(target.id, version);
      if (read) next.add(target.id);
      else next.delete(target.id);
    }
    applyRead(next);

    const mutate = read ? markPreviousChaptersAsRead : markPreviousChaptersAsUnread;
    // The bulk endpoints write their own history rows; the metadata rides along so those
    // rows carry a title even with no manga row to join from.
    mutate(mangaSlug, targets.map(payloadFor), {
      source_manga_id: sourceMangaId,
      title: mangaTitle,
      thumbnail_url: thumbnailUrl || undefined,
    })
      .then(() => {
        if (!requestCurrent(requestGeneration)) return;
        toast({
          description: `Marked ${targets.length} chapter${targets.length === 1 ? '' : 's'} as ${
            read ? 'read' : 'unread'
          }`,
        });
      })
      .catch(() => {
        if (!requestCurrent(requestGeneration)) return;
        const rollback = new Set(readIdsRef.current);
        let changed = false;
        for (const target of targets) {
          const version = versions.get(target.id);
          if (
            version === undefined ||
            latestMutationForChapter.current.get(target.id) !== version
          ) {
            continue;
          }
          if (previousReadById.get(target.id)) rollback.add(target.id);
          else rollback.delete(target.id);
          changed = true;
        }
        if (changed) applyRead(rollback);
        toast({ description: "Couldn't mark previous chapters — try again" });
      })
      .finally(() => {
        if (!requestCurrent(requestGeneration)) return;
        for (const [chapterId, version] of versions) {
          if (latestMutationForChapter.current.get(chapterId) === version) {
            latestMutationForChapter.current.delete(chapterId);
          }
        }
      });
  };

  const download = async (fallback?: Chapters) => {
    const requestGeneration = generation.current;
    if (batchBusy || !requestCurrent(requestGeneration)) return;
    const ids = new Set(
      fallback && !selected.includes(fallback.id) ? [fallback.id] : selected.length ? selected : [],
    );
    const targets = chapters.filter((c) => ids.has(c.id));
    if (!targets.length) return;
    setBatchBusy(true);
    setDownloading(new Set(targets.map((c) => c.id)));
    const failed: string[] = [];
    try {
      const existing = await getAllDownloads();
      const excluded = new Set(
        existing.filter((d) => d.status !== 'FAILED').map((d) => d.chapter_id),
      );
      for (const c of targets) {
        if (!requestCurrent(requestGeneration)) return;
        if (excluded.has(c.id)) continue;
        try {
          await onDownload({
            id: c.id,
            name: c.name || undefined,
            chapter_number: c.chapter_number,
          });
        } catch {
          failed.push(c.id);
        }
      }
      if (requestCurrent(requestGeneration)) {
        setSelected(failed);
        toast({
          description: failed.length
            ? `${failed.length} chapters could not be queued. Retry the remaining selection.`
            : 'Selected chapters queued for download.',
        });
      }
    } catch {
      if (requestCurrent(requestGeneration))
        toast({ description: 'Download status could not be checked. Retry your selection.' });
    } finally {
      if (requestCurrent(requestGeneration)) {
        setBatchBusy(false);
        setDownloading(new Set());
      }
    }
  };
  const markSelected = async (read: boolean) => {
    const version = generation.current;
    if (batchBusy || !requestCurrent(version)) return;
    setBatchBusy(true);
    const failed: string[] = [];
    try {
      const ids = new Set(selected);
      for (const c of chapters.filter((c) => ids.has(c.id))) {
        if (!requestCurrent(version)) return;
        if (readIdsRef.current.has(c.id) !== read && !(await toggleRead(c))) failed.push(c.id);
      }
      if (requestCurrent(version)) setSelected(failed);
    } finally {
      if (requestCurrent(version)) setBatchBusy(false);
    }
  };

  const copyLink = (chapter: Chapters) => {
    void copySourceChapterLink(
      { url: chapter.url, chapterNumber: chapter.chapter_number },
      sourceId,
    );
  };

  const q = query.trim().toLowerCase();
  const filtered = chapters.filter((c) => {
    if (
      status === 'Downloaded'
        ? sessionLoading || downloadsOwner !== owner || !downloadedIds.has(c.id)
        : status === 'Bookmarked'
          ? !isBookmarked(c.id)
          : !passesChapterStatusFilter(readIds.has(c.id), status)
    )
      return false;
    if (q && !String(c.chapter_number).includes(q) && !(c.name ?? '').toLowerCase().includes(q))
      return false;
    if (group !== 'All' && knownGroup(c.scanlator) !== group) return false;
    return true;
  });

  /** Groups that actually appear in this listing, so the control only exists when there is
   * a choice to make. */
  const allGroups = [
    ...new Set(chapters.map((c) => knownGroup(c.scanlator)).filter((g): g is string => !!g)),
  ].sort();
  const sorted = sortByChapterNumber(filtered, sortDir);
  const filterKey = JSON.stringify([q, status, group, sortDir]);
  useChapterFilterScroll(filterKey);
  const chapterWindow = useChapterWindow(
    sorted.length,
    filterKey + (selected.length ? ':selection' : ':browse'),
  );
  const visibleChapters = sorted.slice(chapterWindow.start, chapterWindow.end);

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

          <button
            onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
            // No aria-label: the visible text is the name, so it matches what someone
            // would say to a voice control. What pressing it *does* goes in the title,
            // which becomes the description rather than replacing the name.
            title={sortDir === 'desc' ? 'Switch to oldest first' : 'Switch to latest first'}
            className="flex items-center gap-1.5 rounded-full border border-border/60 bg-surface/40 px-3 py-1.5 text-xs text-muted-foreground transition hover:border-border hover:text-foreground"
          >
            <ArrowUpDown className="h-3.5 w-3.5" />
            {sortDir === 'desc' ? 'Latest first' : 'Oldest first'}
            <SortDirectionIcon direction={sortDir} />
          </button>
        </div>
      </div>
      {status === 'Downloaded' && downloadsError && (
        <p role="status" className="mt-2 text-xs text-destructive">
          Download status could not be loaded. Refresh this page to retry.
        </p>
      )}
      {selected.length > 0 ? (
        <div
          role="toolbar"
          aria-label="Selected chapter actions"
          className="sticky top-36 z-20 mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-primary/30 bg-background/95 p-3 text-xs shadow-lg backdrop-blur sm:top-24"
        >
          <span role="status" className="font-semibold">
            {selected.length} selected
          </span>
          <button disabled={batchBusy} className="text-primary" onClick={() => void download()}>
            Download
          </button>
          <button
            disabled={batchBusy}
            className="text-primary"
            onClick={() => void markSelected(true)}
          >
            Mark read
          </button>
          <button
            disabled={batchBusy}
            className="text-primary"
            onClick={() => void markSelected(false)}
          >
            Mark unread
          </button>
          <button disabled={batchBusy} onClick={() => setSelected([])}>
            Clear
          </button>
        </div>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">
          {coarsePointer
            ? 'Long-press a chapter to select it.'
            : 'Hold a chapter or press Space to select. Right-click for actions.'}
        </p>
      )}

      {sorted.length === 0 ? (
        <div className="mt-4 rounded-xl border border-dashed border-border/60 p-8 text-center text-sm text-muted-foreground">
          {chapters.length === 0
            ? 'This source lists no chapters for this title yet.'
            : 'No chapters match your filters.'}
        </div>
      ) : (
        <ul
          ref={chapterWindow.ref}
          aria-label="Chapters"
          className="mt-4 divide-y divide-border/50 overflow-hidden rounded-xl border border-border/60 bg-surface/40"
        >
          {chapterWindow.top > 0 && <li aria-hidden="true" style={{ height: chapterWindow.top }} />}
          {visibleChapters.map((c, index) => {
            const read = readIds.has(c.id);
            const progress = chapterProgress.get(c.id);
            const pageCount =
              c.page_count && c.page_count > 0 ? c.page_count : (progress?.page_count ?? 0);
            const lastPage = progress?.last_page_read ?? 0;
            const progressLabel =
              !read && lastPage > 0 && pageCount > lastPage ? `${lastPage} / ${pageCount}` : null;
            return (
              <ContextMenu key={c.id} modal={false}>
                <ContextMenuTrigger asChild>
                  <li
                    aria-setsize={sorted.length}
                    aria-posinset={chapterWindow.start + index + 1}
                    className={`flex h-[72px] items-center ${selected.includes(c.id) ? 'bg-primary/15 ring-1 ring-inset ring-primary/40' : 'transition-colors hover:bg-accent'}`}
                  >
                    <button
                      type="button"
                      aria-label={`${isBookmarked(c.id) ? 'Unbookmark' : 'Bookmark'} chapter ${c.chapter_number}`}
                      aria-pressed={isBookmarked(c.id)}
                      // 36px tap target, matching the library's chapter rows.
                      className="ml-1.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg text-sm text-primary hover:bg-accent focus-visible:outline-2 focus-visible:outline-primary"
                      onClick={() => toggleBookmark(c.id)}
                    >
                      {isBookmarked(c.id) ? '★' : '☆'}
                    </button>
                    <ChapterSelectionLink
                      label={`Chapter ${c.chapter_number}${c.name && c.name !== `Chapter ${c.chapter_number}` ? ` · ${c.name}` : ''}${knownGroup(c.scanlator) ? ` · ${knownGroup(c.scanlator)}` : ''}`}
                      href={chapterHref(c)}
                      selected={selected.includes(c.id)}
                      selectionMode={selected.length > 0}
                      disabled={batchBusy}
                      index={chapterWindow.start + index}
                      onNavigate={chapterWindow.onKeyDown}
                      onSelect={() =>
                        setSelected((current) =>
                          current.includes(c.id)
                            ? current.filter((id) => id !== c.id)
                            : [...current, c.id],
                        )
                      }
                    >
                      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-background text-xs font-semibold tabular-nums text-muted-foreground group-hover:text-primary">
                        {c.chapter_number}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-foreground">
                          {c.name || `Chapter ${c.chapter_number}`}
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          {c.release_date ? formatRelative(c.release_date) : 'Unknown date'}
                          {knownGroup(c.scanlator) && ` · ${knownGroup(c.scanlator)}`}
                        </div>
                      </div>
                      {progressLabel && (
                        <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium tabular-nums text-primary">
                          {progressLabel}
                        </span>
                      )}
                      {read && (
                        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                          Read
                        </span>
                      )}
                      <Play className="h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition group-hover:text-primary group-hover:opacity-100" />
                    </ChapterSelectionLink>
                  </li>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem
                    disabled={batchBusy}
                    onSelect={() => {
                      if (selected.includes(c.id) && selected.length > 1) void markSelected(!read);
                      else void toggleRead(c);
                    }}
                  >
                    {read ? (
                      <>
                        <EyeOff className="mr-2 h-3.5 w-3.5" /> Mark as unread
                      </>
                    ) : (
                      <>
                        <Eye className="mr-2 h-3.5 w-3.5" /> Mark as read
                      </>
                    )}
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => markPrevious(c, true)}>
                    <CheckCheck className="mr-2 h-3.5 w-3.5" /> Mark previous as read
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => markPrevious(c, false)}>
                    <ListX className="mr-2 h-3.5 w-3.5" /> Mark previous as unread
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    onSelect={() => void download(c)}
                    disabled={batchBusy || downloading.has(c.id)}
                  >
                    <Download className="mr-2 h-3.5 w-3.5" /> Download{' '}
                    {selected.includes(c.id) && selected.length > 1
                      ? `${selected.length} selected chapters`
                      : 'chapter'}
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => copyLink(c)}>
                    <Link2 className="mr-2 h-3.5 w-3.5" /> Copy link
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
          {chapterWindow.bottom > 0 && (
            <li aria-hidden="true" style={{ height: chapterWindow.bottom }} />
          )}
        </ul>
      )}
    </div>
  );
}
