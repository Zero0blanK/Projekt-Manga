'use client';

import { useEffect, useState, type ReactNode } from 'react';
import {
  getHistory,
  getDownloadStats,
  type HistoryEntry,
  type DownloadStats,
} from '@projekt-manga/api-client';
import { Panel } from '@/components/settings/field-controls';
import { SHELF_OPTIONS, useSetting } from '@/lib/app-store';
import { formatDuration } from '@/lib/manga-data';
import { useMangaLibrary, useLibraryState } from '@/lib/library-store';
import { entriesInGlobalUpdate, isStarted } from '@/lib/library-update';
import { shelfOf as resolveShelf } from '@/components/library/constants';
import { StatCardsSkeleton } from '@/components/skeletons';
import { Skeleton } from '@/components/ui/skeleton';
import { useCurrentUser } from '@/lib/session-resource';
import {
  BookOpen,
  Clock,
  Library as LibraryIcon,
  HardDriveDownload,
  type LucideIcon,
} from 'lucide-react';

function StatCard({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: LucideIcon;
  label: string;
  value: string | number;
  detail?: string;
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-background/40 p-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon className="h-3.5 w-3.5" /> {label}
      </div>
      <div className="mt-2 text-2xl font-semibold tabular-nums text-foreground">{value}</div>
      {detail && <div className="mt-1 text-[11px] text-muted-foreground">{detail}</div>}
    </div>
  );
}

/** A label / number pair, with an optional note explaining what the number counts. */
function StatRow({
  label,
  value,
  note,
  muted = false,
}: {
  label: string;
  value: string | number;
  note?: string;
  muted?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2">
      <div className="min-w-0">
        <div className={`text-sm ${muted ? 'text-muted-foreground' : 'text-foreground'}`}>
          {label}
        </div>
        {note && <div className="mt-0.5 text-[11px] text-muted-foreground">{note}</div>}
      </div>
      <div
        className={`shrink-0 text-sm font-semibold tabular-nums ${
          muted ? 'text-muted-foreground' : 'text-foreground'
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border-t border-border/50 pt-5">
      <div className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        {title}
      </div>
      <div className="mt-2 divide-y divide-border/40">{children}</div>
    </div>
  );
}

const DAY_MS = 24 * 3600_000;

/** Consecutive days ending today (or yesterday) that have at least one history entry. */
function currentStreak(history: HistoryEntry[]): number {
  const days = new Set(history.map((h) => new Date(h.last_read).toDateString()));
  if (days.size === 0) return 0;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  // A streak still counts if today hasn't been read yet but yesterday was.
  const cursor = new Date(today);
  if (!days.has(today.toDateString())) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  while (days.has(cursor.toDateString())) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

export function StatisticsPanel() {
  const { manga: mangaLibrary, loading: libraryLoading } = useMangaLibrary();
  const { shelf, bookmarks } = useLibraryState();
  const skipCompleted = useSetting('skipCompletedOnUpdate', false) as boolean;
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [downloads, setDownloads] = useState<DownloadStats | null>(null);
  const [statsLoaded, setStatsLoaded] = useState(false);
  const [statsError, setStatsError] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  const [activityDays, setActivityDays] = useState<7 | 30>(7);
  const { user, loading: sessionLoading } = useCurrentUser();
  const [loadedOwner, setLoadedOwner] = useState<string | null>(null);

  useEffect(() => {
    if (sessionLoading) return;
    const controller = new AbortController();
    setStatsLoaded(false);
    setStatsError(false);
    Promise.all([getHistory(controller.signal), getDownloadStats(controller.signal)])
      .then(([nextHistory, nextDownloads]) => {
        if (!controller.signal.aborted) {
          setHistory(nextHistory);
          setDownloads(nextDownloads);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setStatsError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setStatsLoaded(true);
          setLoadedOwner(user?.id ?? 'anonymous');
        }
      });
    return () => controller.abort();
  }, [retryToken, user?.id, sessionLoading]);

  const loading =
    sessionLoading || libraryLoading || !statsLoaded || loadedOwner !== (user?.id ?? 'anonymous');

  if (loading) {
    return (
      <div className="space-y-6">
        <Panel title="Statistics" subtitle="Your reading activity at a glance">
          <StatCardsSkeleton />
          <div className="space-y-3 border-t border-border/50 pt-5">
            <Skeleton className="h-3 w-24" />
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-6 w-full" />
            ))}
          </div>
        </Panel>
      </div>
    );
  }
  if (statsError) {
    return (
      <Panel title="Statistics" subtitle="Your reading activity at a glance">
        <p role="alert" className="text-sm text-muted-foreground">
          Statistics are unavailable right now.
        </p>
        <button
          type="button"
          onClick={() => setRetryToken((value) => value + 1)}
          className="mt-3 text-xs text-primary hover:underline"
        >
          Try again
        </button>
      </Panel>
    );
  }

  // Per-manga progress is already a real read/total ratio (from GET /manga's unread_count);
  // reconstructing the read count from it avoids an N+1 chapter-by-chapter query just for
  // this summary number.
  const chaptersRead = mangaLibrary.reduce(
    (sum, m) => sum + Math.round((m.progress ?? 0) * m.chapters),
    0,
  );
  const totalChapters = mangaLibrary.reduce((sum, m) => sum + m.chapters, 0);
  const pctRead = totalChapters ? Math.round((chaptersRead / totalChapters) * 100) : 0;
  const chaptersDownloaded = downloads?.completed ?? 0;

  const shelfOf = (m: (typeof mangaLibrary)[number]) => resolveShelf(m, shelf);
  const shelfCounts = SHELF_OPTIONS.map((o) => ({
    ...o,
    count: mangaLibrary.filter((m) => shelfOf(m) === o.value).length,
  }));
  const completedCount = shelfCounts.find((o) => o.value === 'completed')?.count ?? 0;
  const inGlobalUpdate = entriesInGlobalUpdate(mangaLibrary, shelf, skipCompleted).length;
  const startedCount = mangaLibrary.filter(isStarted).length;
  // Local CBZ files live in their own device collection, outside this source library.
  const localCount = 0;

  // history.time_read accumulates on the server in milliseconds, one row per chapter.
  const totalReadMs = history.reduce((sum, h) => sum + (h.time_read ?? 0), 0);
  const timedEntries = history.filter((h) => (h.time_read ?? 0) > 0);
  const averageChapterMs = timedEntries.length ? totalReadMs / timedEntries.length : 0;
  const weekAgo = Date.now() - 7 * DAY_MS;
  const recentChapters = history.filter((h) => +new Date(h.last_read) >= weekAgo).length;
  const streak = currentStreak(history);

  return (
    <div className="space-y-6">
      <Panel title="Statistics" subtitle="Your reading activity at a glance">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard
            icon={Clock}
            label="Read duration"
            value={formatDuration(totalReadMs)}
            detail={streak > 0 ? `${streak}-day streak` : 'All time'}
          />
          <StatCard
            icon={BookOpen}
            label="Chapters read"
            value={chaptersRead}
            detail={`${pctRead}% of your library`}
          />
          <StatCard
            icon={LibraryIcon}
            label="Entries"
            value={mangaLibrary.length}
            detail={`${startedCount} started`}
          />
          <StatCard
            icon={HardDriveDownload}
            label="Downloaded"
            value={chaptersDownloaded}
            detail={
              downloads && downloads.totalSize > 0
                ? `${(downloads.totalSize / 1024 ** 3).toFixed(2)} GB on disk`
                : 'chapters'
            }
          />
        </div>

        <Section title="Reading activity">
          <StatRow
            label="Total"
            value={formatDuration(totalReadMs)}
            note={
              totalReadMs === 0
                ? 'Recorded from the reader — open a chapter to start tracking'
                : `Across ${timedEntries.length} chapter${timedEntries.length === 1 ? '' : 's'}`
            }
          />
          <StatRow
            label="Chapters active in last 7 days"
            value={recentChapters}
            note="A chapter counts when last opened; historical time cannot be split by day"
          />
          <StatRow label="Average per chapter" value={formatDuration(averageChapterMs)} />
          <StatRow
            label="Current streak"
            value={streak === 0 ? '—' : `${streak} day${streak === 1 ? '' : 's'}`}
            note="Consecutive days with something read"
          />
        </Section>

        <Section title="Entries">
          <StatRow label="In library" value={mangaLibrary.length} />
          <StatRow
            label="In global update"
            value={inGlobalUpdate}
            note={
              skipCompleted
                ? 'Finished titles are skipped — see Sync & Storage'
                : 'Every library entry; enable skipping in Sync & Storage'
            }
          />
          <StatRow label="Started" value={startedCount} note="Opened but not finished" />
          <StatRow label="Completed" value={completedCount} note="On the Completed shelf" />
          <StatRow label="Bookmarked" value={bookmarks.length} />
          <StatRow
            label="Local"
            value={localCount}
            note="Local CBZ comics are managed separately from the source library"
            muted
          />
        </Section>

        <Section title="Chapters">
          <StatRow label="Total" value={totalChapters} />
          <StatRow label="Read" value={chaptersRead} />
          <StatRow label="Unread" value={Math.max(0, totalChapters - chaptersRead)} />
          <StatRow
            label="Downloaded"
            value={chaptersDownloaded}
            note={
              downloads
                ? `${downloads.inProgress} in progress · ${downloads.failed} failed`
                : undefined
            }
          />
        </Section>
      </Panel>

      <Panel
        title="Recent reading activity"
        subtitle="History records grouped by their most recent reading date"
      >
        <div className="flex gap-3">
          {([7, 30] as const).map((days) => (
            <button
              key={days}
              type="button"
              aria-pressed={activityDays === days}
              onClick={() => setActivityDays(days)}
              className="rounded-lg border border-border px-3 py-2 text-xs text-primary"
            >
              {days} days
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          History keeps one latest record per chapter. Pages recorded are cumulative for those
          records; these bars do not reconstruct daily sessions or reading time. Chapters read
          counts only records marked read.
        </p>
        <ReadingActivity history={history} days={activityDays} />
      </Panel>

      <Panel title="Progress" subtitle="How far through your library you are">
        <div>
          <div className="flex items-baseline justify-between">
            <div className="text-sm font-medium text-foreground">Library progress</div>
            <div className="text-xs text-muted-foreground">
              {chaptersRead} / {totalChapters} chapters · {pctRead}%
            </div>
          </div>
          <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-gradient-primary"
              style={{ width: `${pctRead}%` }}
            />
          </div>
        </div>

        <div className="border-t border-border/50 pt-5">
          <div className="text-sm font-medium text-foreground">Shelf breakdown</div>
          <div className="mt-3 space-y-2">
            {shelfCounts.map((o) => (
              <div key={o.value} className="flex items-center gap-3">
                <div className="w-24 shrink-0 text-xs text-muted-foreground">{o.label}</div>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary/70"
                    style={{
                      width: `${mangaLibrary.length ? (o.count / mangaLibrary.length) * 100 : 0}%`,
                    }}
                  />
                </div>
                <div className="w-6 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                  {o.count}
                </div>
              </div>
            ))}
          </div>
        </div>
      </Panel>
    </div>
  );
}

function ReadingActivity({ history, days }: { history: HistoryEntry[]; days: number }) {
  const dates = Array.from({ length: days }, (_, index) => {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - days + 1 + index);
    return date;
  });
  const rows = dates.map((date) => {
    const next = new Date(date);
    next.setDate(next.getDate() + 1);
    const entries = history.filter((entry) => {
      const timestamp = Date.parse(entry.last_read);
      return timestamp >= date.getTime() && timestamp < next.getTime();
    });
    return {
      date: date.toLocaleDateString(),
      pages: entries.reduce((sum, entry) => sum + Math.max(0, entry.pages_read || 0), 0),
      chapters: entries.filter((entry) => entry.is_read).length,
      titles: new Set(entries.map((entry) => `${entry.source}:${entry.manga_slug}`)).size,
    };
  });
  const max = Math.max(1, ...rows.map((row) => row.pages));
  return (
    <div>
      <div aria-hidden="true" className="flex h-32 items-end gap-1">
        {rows.map((row) => (
          <div
            key={row.date}
            title={`${row.date}: ${row.pages} recorded pages`}
            className="min-w-0 flex-1 rounded-t bg-primary/70"
            style={{ height: `${Math.max(row.pages > 0 ? 2 : 0, (row.pages / max) * 100)}%` }}
          />
        ))}
      </div>
      <details className="mt-3">
        <summary className="cursor-pointer text-sm text-primary">View activity table</summary>
        <div className="overflow-x-auto">
          <table className="mt-2 w-full text-left text-xs">
            <caption className="sr-only">
              Recorded reading activity for the last {days} days
            </caption>
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Pages recorded</th>
                <th scope="col">Chapters read</th>
                <th scope="col">Titles continued</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.date}>
                  <th scope="row" className="py-1 font-normal">
                    {row.date}
                  </th>
                  <td>{row.pages}</td>
                  <td>{row.chapters}</td>
                  <td>{row.titles}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
