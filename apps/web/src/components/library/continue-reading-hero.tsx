'use client';

import Link from 'next/link';
import type { HistoryEntry } from '@projekt-manga/api-client';
import { toast } from '@/hooks/use-toast';
import { applyLibraryAction, libraryActions, useLibraryState } from '@/lib/library-store';
import { formatRelative, type Manga } from '@/lib/manga-data';
import { MangaCover } from '@/components/manga-card';
import { Sparkles, Bookmark, Play } from 'lucide-react';

export function ContinueReadingHero({
  manga,
  recentRead,
}: {
  manga: Manga;
  recentRead?: HistoryEntry;
}) {
  const { bookmarks } = useLibraryState();
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

  return (
    <div className="relative mt-6 overflow-hidden rounded-2xl border border-border/60 bg-hero p-4 sm:p-6">
      <div
        className="pointer-events-none absolute inset-0 opacity-60"
        style={{
          backgroundImage:
            'radial-gradient(60% 80% at 80% 50%, oklch(0.78 0.14 55 / 0.15), transparent 70%)',
        }}
      />
      <div className="relative flex items-center gap-3 sm:gap-6">
        <div className="w-20 shrink-0 sm:w-28">
          <MangaCover manga={manga} chapterBadge={false} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.18em] text-primary">
            <Sparkles className="h-3 w-3" /> {started ? 'Continue Reading' : 'Up next'}
          </div>
          <h2 className="mt-2 line-clamp-2 text-display text-2xl leading-tight text-foreground sm:text-3xl">
            {manga.title}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Chapter {chapter}
            {chapterTitle ? ` · ${chapterTitle}` : ''}
          </p>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            {started ? (
              <>
                <div className="h-1.5 min-w-12 flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-gradient-primary transition-all"
                    style={{ width: `${progress * 100}%` }}
                  />
                </div>
                <span className="text-xs tabular-nums text-muted-foreground">{progressLabel}</span>
              </>
            ) : (
              <span className="flex-1 text-xs text-muted-foreground">Not started yet</span>
            )}
            <button
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
              className="flex items-center gap-2 rounded-full bg-foreground px-5 py-2 text-xs font-semibold text-background transition hover:opacity-90"
            >
              <Play className="h-3.5 w-3.5 fill-current" /> {started ? 'Resume' : 'Start reading'}
            </Link>
          </div>
        </div>
        <div className="hidden shrink-0 text-right text-xs text-muted-foreground xl:block">
          Updated {formatRelative(manga.updatedAt)}
        </div>
      </div>
    </div>
  );
}
