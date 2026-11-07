'use client';

import Link from 'next/link';
import type { HistoryEntry } from '@projekt-manga/api-client';
import { toast } from '@/hooks/use-toast';
import {
  applyLibraryAction,
  libraryActions,
  useLibraryState,
  useSources,
} from '@/lib/library-store';
import { formatRelative, type Manga } from '@/lib/manga-data';
import { MangaCover } from '@/components/manga-card';
import { Bookmark, Play } from 'lucide-react';

export function ContinueReadingHero({
  manga,
  recentRead,
}: {
  manga: Manga;
  recentRead?: HistoryEntry;
}) {
  const { bookmarks } = useLibraryState();
  const { sources } = useSources();
  const isBookmarked = bookmarks.includes(manga.id);
  const progress =
    recentRead && recentRead.page_count > 0
      ? Math.min(1, Math.max(0, recentRead.last_page_read / recentRead.page_count))
      : (manga.progress ?? 0);
  const progressLabel =
    recentRead && recentRead.last_page_read > 0 && recentRead.page_count <= 0
      ? `Page ${recentRead.last_page_read}`
      : `${Math.round(progress * 100)}%`;
  const chapter =
    recentRead?.chapter_number && recentRead.chapter_number > 0
      ? recentRead.chapter_number
      : (manga.currentChapter ?? 1);
  const page = recentRead?.last_page_read || manga.currentPage;
  const rawTitle = recentRead?.name ?? manga.currentChapterTitle;
  // Many sources title a chapter just "Chapter 12"; drop it to avoid "Chapter 12 · Chapter 12".
  const chapterTitle = rawTitle && rawTitle.trim() !== `Chapter ${chapter}` ? rawTitle : null;
  // A title added but never opened has nothing to resume: say "start" rather than
  // showing "Continue reading · 0% · Resume".
  const started = !!recentRead || (manga.progress ?? 0) > 0 || (manga.currentPage ?? 0) > 0;

  const toggleBookmark = () => {
    applyLibraryAction(
      libraryActions.toggleBookmark(manga.id),
      "Couldn't update bookmark — it's been restored.",
    );
    toast({
      description: isBookmarked
        ? `Removed ${manga.title} from bookmarks`
        : `Bookmarked ${manga.title}`,
    });
  };

  const sourceName = sources.find((source) => source.id === manga.source)?.name ?? manga.source;
  const people = [...new Set([...(manga.authors ?? []), ...(manga.artists ?? [])])];
  const remaining =
    manga.latestChapterNum > 0 ? Math.max(0, Math.floor(manga.latestChapterNum - chapter)) : 0;
  const pageLabel =
    recentRead && recentRead.page_count > 0
      ? `Page ${Math.max(1, recentRead.last_page_read)} of ${recentRead.page_count}`
      : page
        ? `Page ${page}`
        : null;
  const facts = [
    sourceName,
    manga.status !== 'Unknown' ? manga.status : null,
    manga.latestChapterNum > 0 ? `${manga.latestChapterNum} chapters` : null,
  ].filter(Boolean);

  return (
    <section
      aria-label={started ? 'Continue reading' : 'Up next'}
      className="mt-6 rounded-2xl border border-border/60 bg-surface/50 p-4 sm:p-5"
    >
      <div className="flex gap-4 sm:gap-6">
        <Link
          href={`/manga/${encodeURIComponent(manga.id)}`}
          aria-label={`Open ${manga.title}`}
          className="w-20 shrink-0 sm:w-28"
        >
          <MangaCover manga={manga} chapterBadge={false} />
        </Link>
        <div className="flex min-w-0 flex-1 flex-col">
          <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            <span className="font-semibold uppercase tracking-wider text-primary">
              {started ? 'Continue reading' : 'Up next'}
            </span>
            {recentRead && <span>· read {formatRelative(recentRead.last_read)}</span>}
          </p>
          <h2 className="mt-1 line-clamp-2 text-xl font-semibold leading-tight text-foreground sm:text-2xl">
            {manga.title}
          </h2>
          {people.length > 0 && (
            <p className="mt-0.5 truncate text-sm text-muted-foreground">{people.join(', ')}</p>
          )}
          <p className="mt-1 flex flex-wrap gap-x-1.5 text-xs text-muted-foreground">
            {facts.map((fact, index) => (
              <span key={fact}>
                {index > 0 && '· '}
                {fact}
              </span>
            ))}
            <span>· updated {formatRelative(manga.updatedAt)}</span>
          </p>
          {manga.tags.length > 0 && (
            <ul className="mt-2 hidden flex-wrap gap-1.5 sm:flex" aria-label="Genres">
              {manga.tags.slice(0, 4).map((tag) => (
                <li
                  key={tag}
                  className="rounded-full border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground"
                >
                  {tag}
                </li>
              ))}
            </ul>
          )}

          <div className="mt-auto pt-3">
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate font-medium">
                Chapter {chapter}
                {chapterTitle ? ` · ${chapterTitle}` : ''}
              </span>
              {started && (
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {progressLabel}
                </span>
              )}
            </div>
            {started ? (
              <div
                className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted"
                role="progressbar"
                aria-label="Chapter progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(progress * 100)}
              >
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${progress * 100}%` }}
                />
              </div>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">Not started yet</p>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
              <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                {[
                  started ? pageLabel : null,
                  remaining > 0
                    ? `${remaining} chapter${remaining === 1 ? '' : 's'} after this`
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
              <button
                type="button"
                onClick={toggleBookmark}
                className={`grid h-9 w-9 place-items-center rounded-full border transition ${
                  isBookmarked
                    ? 'border-primary/50 bg-primary/10 text-primary'
                    : 'border-border/60 text-muted-foreground hover:text-foreground'
                }`}
                aria-label={isBookmarked ? 'Remove bookmark' : 'Bookmark'}
                aria-pressed={isBookmarked}
              >
                <Bookmark className={`h-4 w-4 ${isBookmarked ? 'fill-current' : ''}`} />
              </button>
              <Link
                href={`/reader/${manga.id}?ch=${chapter}${recentRead?.chapter_id ? `&chapterId=${encodeURIComponent(recentRead.chapter_id)}` : ''}${page ? `&page=${page}` : ''}`}
                className="flex items-center gap-2 rounded-full bg-primary px-5 py-2 text-xs font-semibold text-primary-foreground transition hover:opacity-90"
              >
                <Play className="h-3.5 w-3.5 fill-current" /> {started ? 'Resume' : 'Start reading'}
              </Link>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
