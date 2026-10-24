'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getHistory, type HistoryEntry as ApiHistoryEntry } from '@projekt-manga/api-client';
import { formatRelative } from '@/lib/manga-data';
import { historyThumbnailUrl } from '@/lib/history-thumbnail';
import { useMangaLibrary } from '@/lib/library-store';
import { Cover } from '@/components/cover';
import { MangaCard } from '@/components/manga-card';
import { MangaGrid } from '@/components/manga-grid';
import {
  PageShell,
  PageHeader,
  PageBody,
  PageSection,
  EmptyState,
  RowList,
} from '@/components/page-shell';
import { RowListSkeleton, MangaGridSkeleton } from '@/components/skeletons';
import { Clock3, Play, RefreshCw, ChevronRight } from 'lucide-react';
import { reportError } from '@/lib/report-error';
import { historyResumeHref, historyTitleHref } from '@/lib/history-navigation';

/** How many history rows to preview here — the full list, with filtering and bulk
 * clearing, stays on /history rather than being duplicated. */
const HISTORY_PREVIEW = 8;
const UPDATED_PREVIEW = 12;

type RecentRead = {
  source: string;
  id: string;
  mangaId: string;
  titleHref: string;
  resumeHref: string;
  title: string;
  thumbnailUrl: string | null;
  chapter: number;
  readAt: string;
  progress: number;
  progressLabel: string;
};

function toRecentRead(e: ApiHistoryEntry): RecentRead {
  return {
    source: e.source,
    id: e.id,
    mangaId: e.manga_id ?? `${e.source}\0${e.manga_slug}`,
    titleHref: historyTitleHref(e),
    resumeHref: historyResumeHref(e),
    title: e.title ?? e.manga_slug,
    thumbnailUrl: historyThumbnailUrl(e.thumbnail_url, e.source, e.manga_id, e.manga_slug),
    chapter: e.chapter_number ?? 0,
    readAt: e.last_read,
    progress: e.page_count > 0 ? Math.min(1, e.last_page_read / e.page_count) : 0,
    progressLabel:
      e.page_count > 0
        ? `${Math.round(Math.min(1, e.last_page_read / e.page_count) * 100)}%`
        : e.last_page_read > 0
          ? `Page ${e.last_page_read}`
          : '0%',
  };
}

/**
 * Two different senses of "recent" in one place: titles the library has newly pulled
 * chapters for, and chapters you've actually been reading. They answer different
 * questions ("what's new for me" vs "where was I"), so they stay as separate sections
 * rather than one merged, ambiguous list.
 */
export function RecentsPageClient() {
  const { manga, loading: libraryLoading } = useMangaLibrary();
  const [reads, setReads] = useState<RecentRead[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState(false);
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setHistoryLoading(true);
    setHistoryError(false);
    getHistory(controller.signal)
      .then((rows) => setReads(rows.map(toRecentRead)))
      // Surfaced so a failed load isn't mistaken for "nothing read yet".
      .catch((error) => {
        if (!controller.signal.aborted) {
          setHistoryError(true);
          reportError(error, "Couldn't load your reading history.");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setHistoryLoading(false);
      });
    return () => controller.abort();
  }, [retryToken]);

  const recentlyUpdated = [...manga]
    .filter((m) => m.chapters > 0)
    .sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt))
    .slice(0, UPDATED_PREVIEW);

  // One row per manga: re-reading the same series shouldn't crowd out everything else.
  const seen = new Set<string>();
  const continueReading = reads
    .filter((r) => (seen.has(r.mangaId) ? false : (seen.add(r.mangaId), true)))
    .slice(0, HISTORY_PREVIEW);

  return (
    <PageShell>
      <PageHeader
        icon={Clock3}
        eyebrow="Recents"
        title="Catch up"
        description="What's new in your library, and where you left off."
      />

      <PageBody>
        <PageSection
          title="Continue reading"
          subtitle="Picks up at your last page"
          action={
            <Link
              href="/history"
              className="flex items-center gap-1 text-xs text-primary hover:opacity-80 pointer-coarse:min-h-6"
            >
              Full history <ChevronRight className="h-3 w-3" />
            </Link>
          }
        >
          {historyLoading && continueReading.length === 0 ? (
            <RowListSkeleton count={HISTORY_PREVIEW} />
          ) : historyError ? (
            <EmptyState>
              Couldn't load recent reading.
              <button
                type="button"
                onClick={() => setRetryToken((value) => value + 1)}
                className="mt-3 block text-xs text-primary hover:underline"
              >
                Try again
              </button>
            </EmptyState>
          ) : !historyLoading && continueReading.length === 0 ? (
            <EmptyState>Nothing read yet — open a chapter to start tracking.</EmptyState>
          ) : (
            <RowList>
              {continueReading.map((r) => (
                <li
                  key={r.id}
                  className="group flex items-center gap-4 p-4 transition hover:bg-accent/40"
                >
                  <Cover
                    sourceId={r.source}
                    src={r.thumbnailUrl}
                    alt={r.title}
                    className="h-16 w-12 shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <Link
                      href={r.titleHref}
                      title={r.title}
                      className="block truncate text-sm font-semibold text-foreground group-hover:text-primary"
                    >
                      {r.title}
                    </Link>
                    <p className="mt-0.5 text-xs text-muted-foreground">Chapter {r.chapter}</p>
                    <div className="mt-2 flex items-center gap-3">
                      <div className="h-1 w-40 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-gradient-primary"
                          style={{ width: `${r.progress * 100}%` }}
                        />
                      </div>
                      <span className="text-[10px] tabular-nums text-muted-foreground">
                        {r.progressLabel}
                      </span>
                    </div>
                  </div>
                  <div className="hidden shrink-0 text-right text-[11px] text-muted-foreground md:block">
                    {formatRelative(r.readAt)}
                  </div>
                  <Link
                    href={r.resumeHref}
                    className="flex shrink-0 items-center gap-1.5 rounded-full bg-foreground px-3 py-1.5 text-[11px] font-semibold text-background transition hover:opacity-90"
                  >
                    <Play className="h-3 w-3 fill-current" /> Resume
                  </Link>
                </li>
              ))}
            </RowList>
          )}
        </PageSection>

        <PageSection
          title="Recently updated"
          subtitle="Newest chapters across your library"
          action={
            <Link
              href="/"
              className="flex items-center gap-1 text-xs text-primary hover:opacity-80 pointer-coarse:min-h-6"
            >
              Open library <ChevronRight className="h-3 w-3" />
            </Link>
          }
        >
          {libraryLoading && recentlyUpdated.length === 0 ? (
            <MangaGridSkeleton count={UPDATED_PREVIEW} />
          ) : !libraryLoading && recentlyUpdated.length === 0 ? (
            <EmptyState icon={RefreshCw}>
              No chapters yet — run Update Library from your library to check your sources.
            </EmptyState>
          ) : (
            <MangaGrid>
              {recentlyUpdated.map((m) => (
                <MangaCard key={m.id} manga={m} />
              ))}
            </MangaGrid>
          )}
        </PageSection>
      </PageBody>
    </PageShell>
  );
}
