'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { authorLine, type Manga } from '@/lib/manga-data';
import { Cover } from '@/components/cover';
import { useSetting } from '@/lib/app-store';
import { BookOpen, Download } from 'lucide-react';
import { useHoldToSelect } from '@/hooks/use-hold-to-select';
import {
  COVER_BADGE_POSITION_SETTING,
  COVER_BADGE_STYLE_SETTING,
  DEFAULT_COVER_BADGE_POSITION,
  DEFAULT_COVER_BADGE_STYLE,
  DOWNLOAD_BADGE_SETTING,
  coverCorner,
  plural,
  resolveBadgePosition,
  resolveBadgeStyle,
  type CoverBadgePosition,
  type CoverBadgeStyle,
} from '@/lib/cover-badges';

type CoverCounts = {
  position: CoverBadgePosition;
  style: CoverBadgeStyle;
  /** 0 when hidden: none unread, turned off, or not in the library. */
  unread: number;
  /** 0 when hidden: none downloaded, or turned off (off by default). */
  downloads: number;
  /** Chapters the title has; null when that count is turned off. */
  total: number | null;
};

/** The counts a cover shows, as Settings > Appearance has them. */
function useCoverCounts(manga: Manga, downloadCount: number, enabled = true): CoverCounts {
  const totalEnabled = useSetting('showChapterBadge', true) !== false;
  const unreadEnabled = useSetting('showUnreadBadge', true) !== false;
  const downloadsEnabled = useSetting(DOWNLOAD_BADGE_SETTING, false) === true;
  const position = resolveBadgePosition(
    useSetting(COVER_BADGE_POSITION_SETTING, DEFAULT_COVER_BADGE_POSITION),
  );
  const style = resolveBadgeStyle(useSetting(COVER_BADGE_STYLE_SETTING, DEFAULT_COVER_BADGE_STYLE));
  // progress is a read/total ratio, so the remainder is what's left unread.
  const unread = Math.max(0, manga.chapters - Math.round((manga.progress ?? 0) * manga.chapters));
  return {
    position,
    style,
    unread: enabled && unreadEnabled && manga.inLibrary ? unread : 0,
    downloads: enabled && downloadsEnabled ? downloadCount : 0,
    total: enabled && totalEnabled ? manga.chapters : null,
  };
}

const hasCounts = (counts: CoverCounts) =>
  counts.unread > 0 || counts.downloads > 0 || counts.total !== null;

function countsLabel(counts: CoverCounts): string {
  return [
    counts.unread > 0 && `${plural(counts.unread, 'unread chapter')}`,
    counts.downloads > 0 && `${plural(counts.downloads, 'downloaded chapter')}`,
    counts.total !== null && `${plural(counts.total, 'chapter')} in all`,
  ]
    .filter(Boolean)
    .join(', ');
}

/**
 * The counts in a corner of the cover. Joined (the default): one block,
 * a coloured segment per count, numbers only: downloaded, then unread, then the
 * chapter count. Pills: a separate chip for each, with its words.
 */
function CoverBadges({ counts }: { counts: CoverCounts }) {
  const label = countsLabel(counts);
  const others = counts.unread > 0 || counts.downloads > 0;
  if (counts.style === 'pills') {
    return (
      <div
        role="img"
        aria-label={label}
        title={label}
        className="flex shrink-0 flex-wrap items-center gap-1.5"
      >
        {counts.downloads > 0 && (
          <span
            aria-hidden
            className={`items-center gap-1 whitespace-nowrap rounded-full bg-foreground px-2 py-0.5 text-[10px] font-semibold text-background ${counts.unread > 0 ? 'hidden @[12rem]:flex' : 'flex'}`}
          >
            <Download size={10} /> {counts.downloads}
          </span>
        )}
        {counts.unread > 0 && (
          <span
            aria-hidden
            className="whitespace-nowrap rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-semibold text-white backdrop-blur"
          >
            {counts.unread} unread
          </span>
        )}
        {counts.total !== null && (
          <span
            aria-hidden
            className={`whitespace-nowrap rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold text-primary-foreground shadow-glow ${others ? 'hidden @[14rem]:block' : ''}`}
          >
            {counts.total} ch
          </span>
        )}
      </div>
    );
  }
  const segment = 'px-1.5 py-1 tabular-nums';
  return (
    <div
      role="img"
      aria-label={label}
      title={label}
      className="flex shrink-0 overflow-hidden rounded-md text-[10px] font-bold leading-none shadow-md"
    >
      {counts.downloads > 0 && (
        <span aria-hidden className={`${segment} bg-foreground text-background`}>
          {counts.downloads}
        </span>
      )}
      {counts.unread > 0 && (
        <span aria-hidden className={`${segment} bg-primary text-primary-foreground`}>
          {counts.unread}
        </span>
      )}
      {counts.total !== null && (
        <span
          aria-hidden
          className={`${segment} bg-black/65 font-semibold text-white backdrop-blur ${others ? 'hidden @[10rem]:block' : ''}`}
        >
          {counts.total} ch
        </span>
      )}
    </div>
  );
}

/** The counts as a line of text, for "Under the title". */
function CoverCountsLine({ counts, onCover }: { counts: CoverCounts; onCover: boolean }) {
  if (!hasCounts(counts)) return null;
  const parts = [
    counts.unread > 0 && (
      <span key="unread" className={onCover ? 'text-white' : 'text-primary'}>
        {counts.unread} unread
      </span>
    ),
    counts.downloads > 0 && (
      <span key="downloads" className="inline-flex items-center gap-0.5">
        <Download size={10} aria-hidden /> {counts.downloads}
      </span>
    ),
    counts.total !== null && <span key="total">{counts.total} ch</span>,
  ].filter(Boolean);
  const label = countsLabel(counts);
  return (
    <p
      aria-label={label}
      title={label}
      className={`mt-0.5 flex items-center gap-1.5 truncate text-[11px] font-medium ${onCover ? 'text-white/75' : 'text-muted-foreground'}`}
    >
      {parts.map((part, index) => (
        <span key={index} aria-hidden className="inline-flex items-center gap-1.5">
          {index > 0 && <span className="opacity-50">·</span>}
          {part}
        </span>
      ))}
    </p>
  );
}

export function MangaCover({
  manga,
  chapterBadge = true,
  statusBadge = true,
  downloaded = false,
  downloadCount = 0,
  titleOnCover = false,
  countsBelowTitle = false,
}: {
  manga: Manga;
  /** Has downloaded chapters, so it can still be read without a connection. */
  downloaded?: boolean;
  /** Downloaded chapters, for the count (Settings > Appearance, off by default). */
  downloadCount?: number;
  /** Pass false where the status already sits beside the title, so a screen reader
   * doesn't announce it twice. */
  statusBadge?: boolean;
  /** Callers that never want the counts (hero, cover dialog) pass false; when true they
   * still follow Settings > Appearance > Cover badges. */
  chapterBadge?: boolean;
  /** The compact grid's title sits over the bottom of the cover. */
  titleOnCover?: boolean;
  /** The card shows the counts under its title instead. */
  countsBelowTitle?: boolean;
}) {
  const counts = useCoverCounts(manga, downloadCount, chapterBadge);
  const corner =
    countsBelowTitle || !hasCounts(counts) ? null : coverCorner(counts.position, { titleOnCover });
  const top = corner === 'top-left' || corner === 'top-right';
  const right = corner === 'top-right' || corner === 'bottom-right';
  const badges = corner ? <CoverBadges counts={counts} /> : null;
  // The offline icon says the same as a download count, so it gives way to one.
  const showOffline = downloaded && counts.downloads === 0;
  return (
    // A size container: the chips follow the cover's own width, not the window's. A cover
    // is narrow on a wide window too, e.g. with the Recently Updated rail open.
    <div className="@container relative aspect-[2/3] w-full overflow-hidden rounded-xl shadow-cover">
      <Cover
        sourceId={manga.source}
        src={manga.thumbnailUrl}
        alt={manga.title}
        rounded="rounded-xl"
        className="absolute inset-0 h-full w-full"
      />
      {/* Scrim so the status/chapter chips stay readable over light artwork. */}
      <div className="pointer-events-none absolute inset-0 bg-linear-to-b from-black/50 via-transparent to-transparent" />
      {showOffline && (
        <div
          role="img"
          className={`absolute bottom-2 grid size-6 place-items-center rounded-full bg-black/60 text-white backdrop-blur ${corner === 'bottom-right' ? 'left-2' : 'right-2'}`}
          title="Has downloaded chapters"
          aria-label="Has downloaded chapters"
        >
          <Download size={13} aria-hidden="true" />
        </div>
      )}

      <div className="absolute inset-x-0 top-0 flex items-start gap-1.5 p-2 @[11rem]:p-3">
        {top && !right && badges}
        {/* On a narrow cover the status gives way to counts on the same row. */}
        {statusBadge && (
          <div
            className={`min-w-0 truncate rounded-md bg-black/40 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-white/90 backdrop-blur ${top && !right ? 'ml-auto' : ''} ${top ? 'hidden @[10rem]:block' : ''}`}
          >
            {manga.status}
          </div>
        )}
        {top && right && <div className="ml-auto flex shrink-0">{badges}</div>}
      </div>
      {corner && !top && (
        <div className={`absolute bottom-0 p-2 @[11rem]:p-3 ${right ? 'right-0' : 'left-0'}`}>
          {badges}
        </div>
      )}
    </div>
  );
}

export function MangaCard({
  manga,
  selected = false,
  selectionMode = false,
  onSelect,
  onOpenActions,
  compact = false,
  downloaded = false,
  downloadCount = 0,
}: {
  manga: Manga;
  downloaded?: boolean;
  /** Downloaded chapters, for the count (Settings > Appearance, off by default). */
  downloadCount?: number;
  selected?: boolean;
  selectionMode?: boolean;
  onSelect?: () => void;
  onOpenActions?: () => void;
  /** The compact grid: the title sits on the cover instead of below it. */
  compact?: boolean;
}) {
  const hold = useHoldToSelect({ onSelect: () => onSelect?.(), disabled: !onSelect });
  const router = useRouter();
  const counts = useCoverCounts(manga, downloadCount);
  const countsBelow = counts.position === 'below-title';
  // A title with a chapter under way offers to continue it straight from the cover.
  const resumeHref =
    manga.currentChapter !== undefined
      ? `/reader/${manga.id}?ch=${manga.currentChapter}${manga.currentPage ? `&page=${manga.currentPage}` : ''}`
      : null;
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
      className={`flex flex-col gap-3 rounded-xl outline-none ${selectionMode ? 'focus-visible:ring-2 focus-visible:ring-primary' : 'group'} ${onSelect ? 'select-none touch-pan-y' : ''}`}
    >
      <div className="relative transition-transform duration-500 group-hover:-translate-y-1">
        <MangaCover
          manga={manga}
          downloaded={downloaded}
          downloadCount={downloadCount}
          titleOnCover={compact}
          countsBelowTitle={countsBelow}
        />
        {selected && (
          <div className="pointer-events-none absolute inset-0 rounded-xl bg-primary/25 ring-2 ring-primary" />
        )}
        <div className="pointer-events-none absolute inset-0 rounded-xl ring-1 ring-white/5 transition group-hover:ring-primary/50 group-focus-visible:ring-2 group-focus-visible:ring-primary" />
        <div className="absolute inset-0 flex items-center justify-center opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100">
          {resumeHref && !selectionMode ? (
            // Not a link of its own (no link inside a link): a click here opens the reader,
            // a click anywhere else on the card the title page.
            <span
              data-continue-reading
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                router.push(resumeHref);
              }}
              className="flex cursor-pointer items-center gap-2 rounded-full bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow"
            >
              <BookOpen className="h-3.5 w-3.5" /> Continue · Ch {manga.currentChapter}
            </span>
          ) : (
            <div className="flex items-center gap-2 rounded-full bg-background/85 px-3 py-1.5 text-xs font-medium text-foreground backdrop-blur">
              <BookOpen className="h-3.5 w-3.5" /> Read
            </div>
          )}
        </div>
        {compact && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 rounded-b-xl bg-linear-to-t from-black/85 via-black/50 to-transparent px-2.5 pb-2 pt-8">
            <h3 className="line-clamp-2 text-xs font-semibold text-white">{manga.title}</h3>
            {countsBelow && <CoverCountsLine counts={counts} onCover />}
          </div>
        )}
      </div>
      {!compact && (
        <div className="px-0.5">
          <h3 className="line-clamp-2 text-sm font-semibold text-foreground group-hover:text-primary">
            {manga.title}
          </h3>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{authorLine(manga)}</p>
          {countsBelow && <CoverCountsLine counts={counts} onCover={false} />}
        </div>
      )}
    </Link>
  );
}
