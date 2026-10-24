'use client';

import Link from 'next/link';
import { authorLine, type Manga } from '@/lib/manga-data';
import { Cover, GRID_COVER_SIZES } from '@/components/cover';
import { useSetting } from '@/lib/app-store';
import { BookOpen } from 'lucide-react';
import { useHoldToSelect } from '@/hooks/use-hold-to-select';

export function MangaCover({
  manga,
  chapterBadge = true,
  statusBadge = true,
}: {
  manga: Manga;
  /** Pass false where the status already sits beside the title, so a screen reader
   * doesn't announce it twice. */
  statusBadge?: boolean;
  /** Callers that never want the chip (hero, cover dialog) pass false; when true it still
   * defers to Settings > Appearance > Show chapter badge on covers. */
  chapterBadge?: boolean;
}) {
  const badgeEnabled = useSetting('showChapterBadge', true) as boolean;
  const unreadEnabled = useSetting('showUnreadBadge', true) as boolean;
  const showBadge = chapterBadge && badgeEnabled;
  // progress is a read/total ratio, so the remainder is what's left unread.
  const unread = Math.max(0, manga.chapters - Math.round((manga.progress ?? 0) * manga.chapters));
  const showUnread = chapterBadge && unreadEnabled && unread > 0 && manga.inLibrary;
  return (
    <div className="relative aspect-[2/3] w-full overflow-hidden rounded-xl shadow-cover">
      <Cover
        sourceId={manga.source}
        src={manga.thumbnailUrl}
        alt={manga.title}
        rounded="rounded-xl"
        sizes={GRID_COVER_SIZES}
        className="absolute inset-0 h-full w-full"
      />
      {/* Scrim so the status/chapter chips stay readable over light artwork. */}
      <div className="pointer-events-none absolute inset-0 bg-linear-to-b from-black/50 via-transparent to-transparent" />

      <div className="absolute inset-x-0 top-0 flex items-start justify-between p-3">
        {statusBadge ? (
          <div className="rounded-md bg-black/40 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-white/90 backdrop-blur">
            {manga.status}
          </div>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-1.5">
          {/* The unread pill says "unread" and the latest-chapter pill says "Ch." so the two
              numbers can't be confused. On phones only the unread count shows, so the pills
              don't cover a small cover. */}
          {showUnread && (
            <div
              className="whitespace-nowrap rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-semibold text-white backdrop-blur"
              title={`${unread} unread chapter${unread === 1 ? '' : 's'}`}
              aria-label={`${unread} unread chapter${unread === 1 ? '' : 's'}`}
            >
              {unread} unread
            </div>
          )}
          {showBadge && (
            <div
              className={`whitespace-nowrap rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold text-primary-foreground shadow-glow ${showUnread ? 'hidden sm:block' : ''}`}
              title={`Latest chapter: ${manga.latestChapterNum}`}
              aria-label={`Latest chapter ${manga.latestChapterNum}`}
            >
              Ch. {manga.latestChapterNum}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function MangaCard({
  manga,
  selected = false,
  selectionMode = false,
  onSelect,
  onOpenActions,
}: {
  manga: Manga;
  selected?: boolean;
  selectionMode?: boolean;
  onSelect?: () => void;
  onOpenActions?: () => void;
}) {
  const hold = useHoldToSelect({ onSelect: () => onSelect?.(), disabled: !onSelect });
  return (
    <Link
      {...hold}
      onPointerDown={(event) => {
        hold.onPointerDown(event);
        if (onSelect && event.pointerType !== 'mouse') event.stopPropagation();
      }}
      href={`/manga/${manga.id}`}
      data-library-selection={manga.id}
      aria-label={
        onSelect
          ? `${manga.title}${selected ? ', selected' : ', hold or press Space to select'}`
          : undefined
      }
      onClick={(event) => {
        if (selectionMode) {
          event.preventDefault();
          onSelect?.();
        }
      }}
      onContextMenu={(event) => {
        if (onOpenActions) {
          event.preventDefault();
          onOpenActions();
        }
      }}
      onDragStart={(event) => {
        if (onSelect) event.preventDefault();
      }}
      className={`flex flex-col gap-3 outline-none ${selectionMode ? '' : 'group'} ${onSelect ? 'select-none touch-pan-y' : ''}`}
    >
      <div className="relative transition-transform duration-500 group-hover:-translate-y-1">
        <MangaCover manga={manga} />
        {selected && (
          <div className="pointer-events-none absolute inset-0 rounded-xl bg-primary/25 ring-2 ring-primary" />
        )}
        <div className="pointer-events-none absolute inset-0 rounded-xl ring-1 ring-white/5 transition group-hover:ring-primary/50 group-focus-visible:ring-2 group-focus-visible:ring-primary" />
        <div className="absolute inset-0 flex items-center justify-center opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100">
          <div className="flex items-center gap-2 rounded-full bg-background/85 px-3 py-1.5 text-xs font-medium text-foreground backdrop-blur">
            <BookOpen className="h-3.5 w-3.5" /> Read
          </div>
        </div>
      </div>
      <div className="px-0.5">
        <h3 className="line-clamp-2 text-sm font-semibold text-foreground group-hover:text-primary">
          {manga.title}
        </h3>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{authorLine(manga)}</p>
      </div>
    </Link>
  );
}
