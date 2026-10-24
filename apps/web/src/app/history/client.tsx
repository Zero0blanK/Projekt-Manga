'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { toast } from '@/hooks/use-toast';
import { ToastAction } from '@/components/ui/toast';
import { formatRelative, formatDuration } from '@/lib/manga-data';
import {
  getHistory,
  deleteHistory,
  type HistoryEntry as ApiHistoryEntry,
} from '@projekt-manga/api-client';
import { historyThumbnailUrl } from '@/lib/history-thumbnail';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { Checkbox } from '@/components/ui/checkbox';
import { Cover } from '@/components/cover';
import { PageShell, PageHeader, EmptyState, RowList } from '@/components/page-shell';
import { RowListSkeleton } from '@/components/skeletons';
import { Clock3, Play, Trash2, X, ChevronDown } from 'lucide-react';
import { historyResumeHref, historyTitleHref } from '@/lib/history-navigation';

type JoinedEntry = {
  source: string;
  id: string;
  mangaId: string;
  titleHref: string;
  resumeHref: string;
  title: string;
  thumbnailUrl: string | null;
  chapter: number;
  chapterTitle: string;
  readAt: string;
  progress: number;
  progressLabel: string;
  /** Milliseconds actually spent reading this chapter, from the reader's own clock —
   * accumulates server-side, so this is the real figure, not an estimate. */
  timeReadMs: number;
};

function toJoined(e: ApiHistoryEntry): JoinedEntry {
  const mangaId = e.manga_id ?? `${e.source}\0${e.manga_slug}`;
  return {
    source: e.source,
    id: e.id,
    mangaId,
    titleHref: historyTitleHref(e),
    resumeHref: historyResumeHref(e),
    title: e.title ?? e.manga_slug,
    // The API already returns the source thumbnail; route it through the image proxy.
    thumbnailUrl: historyThumbnailUrl(e.thumbnail_url, e.source, e.manga_id, e.manga_slug),
    chapter: e.chapter_number ?? 0,
    chapterTitle: e.name ?? (e.chapter_number ? `Chapter ${e.chapter_number}` : ''),
    readAt: e.last_read || e.read_at,
    progress: e.page_count > 0 ? Math.min(1, e.last_page_read / e.page_count) : 0,
    progressLabel:
      e.page_count > 0
        ? `${Math.round(Math.min(1, e.last_page_read / e.page_count) * 100)}%`
        : e.last_page_read > 0
          ? `Page ${e.last_page_read}`
          : '0%',
    timeReadMs: e.time_read ?? 0,
  };
}

/** How long a removed entry stays hidden-but-recoverable before the delete actually
 * reaches the server — gives the "Undo" toast action something to cancel. */
const REMOVE_GRACE_MS = 5000;

function useHistory() {
  const [entries, setEntries] = useState<JoinedEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [retryToken, setRetryToken] = useState(0);
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  const pendingTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    getHistory(controller.signal)
      .then((rows) => {
        setEntries(rows.map(toJoined));
        setError(null);
      })
      .catch((err) => {
        // A cancelled request isn't a failure to report. Without this, StrictMode's
        // mount → cleanup → mount cycle aborts the first fetch and leaves that abort
        // showing as a permanent error banner over the data the second fetch loaded.
        if (controller.signal.aborted) return;
        setError(err);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [retryToken]);

  // A scheduled delete still lands if the reader navigates away inside the grace window.
  // The timer handles are kept so the toast's Undo action can cancel them even after
  // this page unmounts.
  const scheduleRemove = (ids: string[]) => {
    setHiddenIds((prev) => new Set([...prev, ...ids]));
    for (const id of ids) {
      const timer = setTimeout(() => {
        pendingTimers.current.delete(id);
        deleteHistory(id).catch(() => {
          // Un-hide it: the row is still on the server, so leaving it hidden would make
          // the entry silently reappear on the next load with no explanation.
          setHiddenIds((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
          toast({ variant: 'destructive', description: "Couldn't remove that entry — it's back." });
        });
      }, REMOVE_GRACE_MS);
      pendingTimers.current.set(id, timer);
    }
  };

  const undo = (ids: string[]) => {
    for (const id of ids) {
      const timer = pendingTimers.current.get(id);
      if (timer) {
        clearTimeout(timer);
        pendingTimers.current.delete(id);
      }
    }
    setHiddenIds((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.delete(id));
      return next;
    });
  };

  const visible = useMemo(() => entries.filter((e) => !hiddenIds.has(e.id)), [entries, hiddenIds]);

  return {
    entries: visible,
    loading,
    error,
    retry: () => setRetryToken((value) => value + 1),
    scheduleRemove,
    undo,
  };
}

const RANGE_OPTIONS = ['All time', 'Today', 'Yesterday', 'Last 7 days', 'Last 30 days'] as const;
type RangeFilter = (typeof RANGE_OPTIONS)[number];

function withinRange(readAt: string, range: RangeFilter): boolean {
  if (range === 'All time') return true;
  const now = new Date();
  const d = new Date(readAt);
  if (range === 'Today') return d.toDateString() === now.toDateString();
  if (range === 'Yesterday') {
    const yest = new Date(now);
    yest.setDate(yest.getDate() - 1);
    return d.toDateString() === yest.toDateString();
  }
  const days = range === 'Last 7 days' ? 7 : 30;
  return now.getTime() - d.getTime() <= days * 24 * 3600_000;
}

function groupByDay(entries: JoinedEntry[]) {
  const groups: Record<string, JoinedEntry[]> = {};
  for (const e of entries) {
    const d = new Date(e.readAt);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    (groups[key] ||= []).push(e);
  }
  return groups;
}

function dayLabel(day: string): string {
  const date = new Date(`${day}T12:00:00`);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** Consecutive-preserving grouping — entries already come newest-first per manga. */
function groupByManga(entries: JoinedEntry[]) {
  const order: string[] = [];
  const byManga = new Map<string, JoinedEntry[]>();
  for (const e of entries) {
    if (!byManga.has(e.mangaId)) {
      byManga.set(e.mangaId, []);
      order.push(e.mangaId);
    }
    byManga.get(e.mangaId)!.push(e);
  }
  return order.map((id) => byManga.get(id)!);
}

function ProgressRow({ entry }: { entry: JoinedEntry }) {
  return (
    <div className="mt-2 flex items-center gap-3">
      <div className="h-1 w-40 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-gradient-primary"
          style={{ width: `${entry.progress * 100}%` }}
        />
      </div>
      <span className="text-[10px] tabular-nums text-muted-foreground">{entry.progressLabel}</span>
    </div>
  );
}

/** A single, ungrouped history row — used when a manga has only one entry in view. */
function SingleRow({
  e,
  onRemove,
}: {
  e: JoinedEntry;
  onRemove: (entries: JoinedEntry[]) => void;
}) {
  return (
    <li className="group flex items-center gap-4 p-4 transition hover:bg-accent/40">
      <Cover
        sourceId={e.source}
        src={e.thumbnailUrl}
        alt={e.title}
        className="h-16 w-12 shrink-0"
      />
      <div className="min-w-0 flex-1">
        <Link
          href={e.titleHref}
          className="block truncate text-sm font-semibold text-foreground group-hover:text-primary"
        >
          {e.title}
        </Link>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {chapterLine(e.chapter, e.chapterTitle)}
        </p>
        <ProgressRow entry={e} />
      </div>
      <div className="hidden shrink-0 text-right text-[11px] text-muted-foreground md:block">
        {formatRelative(e.readAt)}
      </div>
      <Link
        href={e.resumeHref}
        className="flex shrink-0 items-center gap-1.5 rounded-full bg-foreground px-3 py-1.5 text-[11px] font-semibold text-background transition hover:opacity-90"
      >
        <Play className="h-3 w-3 fill-current" /> Resume
      </Link>
      <button
        onClick={() => onRemove([e])}
        aria-label="Remove from history"
        className="grid h-8 w-8 pointer-coarse:size-11 shrink-0 place-items-center rounded-lg text-muted-foreground opacity-0 transition hover:bg-accent hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </li>
  );
}

/** Multiple chapters read for the same manga — collapsed behind a chapters dropdown so
 * one series read many times in a session doesn't flood the list with repeat rows. */
function GroupedRow({
  entries,
  onRemove,
}: {
  entries: JoinedEntry[];
  onRemove: (entries: JoinedEntry[]) => void;
}) {
  const latest = entries[0];
  return (
    <li className="group flex items-center gap-4 p-4 transition hover:bg-accent/40">
      <Cover
        sourceId={latest.source}
        src={latest.thumbnailUrl}
        alt={latest.title}
        className="h-16 w-12 shrink-0"
      />
      <div className="min-w-0 flex-1">
        <Link
          href={latest.titleHref}
          className="block truncate text-sm font-semibold text-foreground group-hover:text-primary"
        >
          {latest.title}
        </Link>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {entries.length} chapters read · latest Chapter {latest.chapter}
        </p>
        <ProgressRow entry={latest} />
      </div>
      <div className="hidden shrink-0 text-right text-[11px] text-muted-foreground md:block">
        {formatRelative(latest.readAt)}
      </div>

      <DropdownMenu modal={false}>
        <DropdownMenuTrigger className="flex shrink-0 items-center gap-1 rounded-full border border-border/60 px-3 py-1.5 text-[11px] font-medium text-foreground transition hover:bg-accent">
          {entries.length} chapters <ChevronDown className="h-3 w-3 opacity-60" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-80 w-72 overflow-auto">
          {entries.map((e) => (
            <div key={e.id}>
              <DropdownMenuItem asChild>
                <Link href={e.resumeHref} className="min-w-0 truncate text-xs">
                  {chapterLine(e.chapter, e.chapterTitle)} · {formatRelative(e.readAt)}
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onRemove([e])} className="text-xs text-destructive">
                <X className="h-3 w-3" /> Remove Chapter {e.chapter}
              </DropdownMenuItem>
            </div>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <Link
        href={latest.resumeHref}
        className="flex shrink-0 items-center gap-1.5 rounded-full bg-foreground px-3 py-1.5 text-[11px] font-semibold text-background transition hover:opacity-90"
      >
        <Play className="h-3 w-3 fill-current" /> Resume
      </Link>
      <button
        onClick={() => onRemove(entries)}
        aria-label={`Remove ${latest.title} from history`}
        className="grid h-8 w-8 pointer-coarse:size-11 shrink-0 place-items-center rounded-lg text-muted-foreground opacity-0 transition hover:bg-accent hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </li>
  );
}

/** "Chapter 3 · The Duel", or just "Chapter 3" when the name only repeats the number. */
function chapterLine(chapter: number | string, title: string) {
  const name = title.trim();
  return name && name !== `Chapter ${chapter}`
    ? `Chapter ${chapter} · ${name}`
    : `Chapter ${chapter}`;
}

export function HistoryPageClient() {
  const { entries: history, loading, error, retry, scheduleRemove, undo } = useHistory();
  const [filterRange, setFilterRange] = useState<RangeFilter>('All time');
  const [clearOpen, setClearOpen] = useState(false);
  const [selectedDays, setSelectedDays] = useState<Set<string>>(new Set());

  const removeWithUndo = (entries: JoinedEntry[]) => {
    if (entries.length === 0) return;
    const ids = entries.map((e) => e.id);
    scheduleRemove(ids);
    toast({
      description: `${entries.length} chapter${entries.length === 1 ? '' : 's'} removed from history`,
      action: (
        <ToastAction altText="Undo" onClick={() => undo(ids)}>
          Undo
        </ToastAction>
      ),
    });
  };

  const visible = history.filter((e) => withinRange(e.readAt, filterRange));
  const filtersActive = filterRange !== 'All time';

  const groups = groupByDay(visible);
  // Real accrued reading time from the reader's own clock (history.time_read), not an
  // estimate — matches the figure Settings > Statistics reports from the same field.
  const totalReadMs = history.reduce((sum, e) => sum + e.timeReadMs, 0);

  // The clear-history dialog always works over the full, unfiltered history — it's a
  // page-wide action, not scoped to whatever manga filter happens to be applied.
  const allDayGroups = useMemo(() => groupByDay(history), [history]);
  const dayEntries = Object.entries(allDayGroups);
  const selectedCount = dayEntries
    .filter(([day]) => selectedDays.has(day))
    .reduce((sum, [, items]) => sum + items.length, 0);

  const toggleDay = (day: string) =>
    setSelectedDays((prev) => {
      const next = new Set(prev);
      if (next.has(day)) next.delete(day);
      else next.add(day);
      return next;
    });

  const confirmClear = () => {
    const toRemove = dayEntries
      .filter(([day]) => selectedDays.has(day))
      .flatMap(([, items]) => items);
    removeWithUndo(toRemove);
  };

  return (
    <PageShell>
      <PageHeader
        icon={Clock3}
        eyebrow="Reading history"
        title="Where you've been"
        description={
          <>
            <span className="text-foreground">{history.length}</span>{' '}
            {history.length === 1 ? 'chapter' : 'chapters'}
            {totalReadMs > 0 && (
              <>
                {' · '}
                <span className="text-foreground">{formatDuration(totalReadMs)}</span> of reading
              </>
            )}
          </>
        }
        actions={
          history.length > 0 ? (
            <>
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger className="flex h-9 items-center gap-2 rounded-lg border border-border/60 px-3 text-xs text-muted-foreground hover:text-foreground">
                  <Clock3 className="h-3.5 w-3.5" /> {filterRange}
                  <ChevronDown className="h-3 w-3 opacity-60" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  {RANGE_OPTIONS.map((r) => (
                    <DropdownMenuItem
                      key={r}
                      onSelect={() => setFilterRange(r)}
                      className={r === filterRange ? 'text-primary' : ''}
                    >
                      {r}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              <AlertDialog
                open={clearOpen}
                onOpenChange={(v) => {
                  setClearOpen(v);
                  if (v) setSelectedDays(new Set(Object.keys(allDayGroups)));
                }}
              >
                <AlertDialogTrigger asChild>
                  <button className="flex h-9 items-center gap-2 rounded-lg border border-border/60 px-3 text-xs text-muted-foreground hover:text-foreground">
                    <Trash2 className="h-3.5 w-3.5" /> Clear history
                  </button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Clear reading history</AlertDialogTitle>
                    <AlertDialogDescription>
                      Choose which days to remove. You can undo this right after from the
                      confirmation toast.
                    </AlertDialogDescription>
                  </AlertDialogHeader>

                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">
                      {dayEntries.length} day{dayEntries.length === 1 ? '' : 's'} of history
                    </span>
                    <div className="flex gap-3">
                      <button
                        onClick={() => setSelectedDays(new Set(dayEntries.map(([day]) => day)))}
                        className="text-primary hover:opacity-80"
                      >
                        Select all
                      </button>
                      <button
                        onClick={() => setSelectedDays(new Set())}
                        className="text-primary hover:opacity-80"
                      >
                        Select none
                      </button>
                    </div>
                  </div>

                  <div className="max-h-64 space-y-0.5 overflow-auto rounded-lg border border-border/60 p-1.5">
                    {dayEntries.map(([day, items]) => (
                      <label
                        key={day}
                        className="flex cursor-pointer items-center gap-3 rounded-md px-2.5 py-2 hover:bg-accent/60"
                      >
                        <Checkbox
                          checked={selectedDays.has(day)}
                          onCheckedChange={() => toggleDay(day)}
                        />
                        <span className="flex-1 text-sm text-foreground">{dayLabel(day)}</span>
                        <span className="text-xs text-muted-foreground">
                          {items.length} chapter{items.length === 1 ? '' : 's'}
                        </span>
                      </label>
                    ))}
                  </div>

                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={confirmClear}
                      disabled={selectedCount === 0}
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    >
                      Delete {selectedCount} chapter{selectedCount === 1 ? '' : 's'}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </>
          ) : undefined
        }
      />

      <div className="mt-10 space-y-10">
        {loading ? (
          <RowListSkeleton count={8} />
        ) : error ? (
          <EmptyState>
            Couldn't load your reading history.
            <button
              onClick={retry}
              className="mt-3 block w-full text-xs text-primary hover:opacity-80"
            >
              Try again
            </button>
          </EmptyState>
        ) : history.length === 0 ? (
          <EmptyState>
            Nothing read yet — open a chapter to start tracking.
            <Link
              href="/"
              className="mt-3 inline-flex items-center text-xs text-primary hover:opacity-80 pointer-coarse:min-h-6"
            >
              Go to library
            </Link>
          </EmptyState>
        ) : visible.length === 0 ? (
          <EmptyState>
            No history {filterRange !== 'All time' ? `in ${filterRange.toLowerCase()}` : ''}.
            {filtersActive && (
              <button
                onClick={() => setFilterRange('All time')}
                className="mt-3 block w-full text-xs text-primary hover:opacity-80"
              >
                Reset filter
              </button>
            )}
          </EmptyState>
        ) : (
          Object.entries(groups).map(([day, items]) => (
            <section key={day}>
              <h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                {dayLabel(day)}
              </h2>
              <div className="mt-3">
                <RowList>
                  {groupByManga(items).map((entries) =>
                    entries.length === 1 ? (
                      <SingleRow key={entries[0].id} e={entries[0]} onRemove={removeWithUndo} />
                    ) : (
                      <GroupedRow
                        key={entries[0].mangaId}
                        entries={entries}
                        onRemove={removeWithUndo}
                      />
                    ),
                  )}
                </RowList>
              </div>
            </section>
          ))
        )}
      </div>
    </PageShell>
  );
}
