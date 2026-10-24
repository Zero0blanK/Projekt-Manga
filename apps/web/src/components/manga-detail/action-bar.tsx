'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { toast } from '@/hooks/use-toast';
import { SHELF_OPTIONS, type ShelfStatus } from '@/lib/app-store';
import { applyLibraryAction, libraryActions, useLibraryState } from '@/lib/library-store';
import { fromMangaDetails, type Manga } from '@/lib/manga-data';
import {
  getMangaChapters,
  getMangaDetailsById,
  hasLocalDataBridge,
  getAllDownloads,
  setMangaInLibrary,
  initiateDownload,
  cancelDownload,
  type MangaChapterRecord,
  type DownloadSummary,
} from '@projekt-manga/api-client';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Play, Bookmark, BookPlus, Share2, Download, ChevronDown, Check } from 'lucide-react';
import { refreshDownloads as refreshDownloadStore } from '@/components/downloads/row-data';
import { TrackerLinkButton } from '@/components/manga-detail/tracker-link-button';
import { shareSourceMangaLink } from '@/lib/source-url';
import { reportError } from '@/lib/report-error';
import { SourceSwitch } from './source-switch';

function ContinueReadingLink({ manga }: { manga: Manga }) {
  const [localPosition, setLocalPosition] = useState<Manga | null>(null);
  useEffect(() => {
    if (!hasLocalDataBridge()) return;
    let active = true;
    getMangaDetailsById(manga.id)
      .then((details) => {
        if (active && details) setLocalPosition(fromMangaDetails(details));
      })
      .catch((error) => {
        if (active) reportError(error, "Couldn't load your local reading position.");
      });
    return () => {
      active = false;
    };
  }, [manga.id]);

  // Keyed off the resume target, not `progress`: progress counts finished chapters, so a
  // reader who stopped part-way through their first chapter had nothing marked read and
  // would be sent back to chapter 1 despite having somewhere to resume.
  const position = localPosition?.id === manga.id ? localPosition : manga;
  const hasProgress = position.currentChapter !== undefined;
  const startChapter = position.currentChapter ?? 1;
  const pageParam = position.currentPage ? `&page=${position.currentPage}` : '';

  return (
    <Link
      href={`/reader/${manga.id}?ch=${startChapter}${pageParam}`}
      className="flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground shadow-glow transition hover:opacity-90"
    >
      <Play className="h-4 w-4 fill-current" />
      {hasProgress ? `Continue Ch. ${startChapter}` : 'Start Reading'}
    </Link>
  );
}

/**
 * Shelf picker for a title that's already in the library. Library membership and shelf
 * are independent: everything here is already under "All", and a shelf is an optional
 * extra label — hence "No shelf" as a real, selectable state rather than an implied one.
 */
function ShelfMenu({ manga, onRemoved }: { manga: Manga; onRemoved?: () => void }) {
  const router = useRouter();
  const { shelf } = useLibraryState();
  const shelfStatus = shelf[manga.id];
  const [removing, setRemoving] = useState(false);

  /** Library membership and shelf are separate, so this lives at the bottom of the shelf
   * menu rather than as a button of its own: it's the counterpart to "Add to Library",
   * and the row itself survives (in_library=false) so downloads and reading progress
   * attached to it aren't destroyed. */
  const removeFromLibrary = () => {
    if (removing) return;
    setRemoving(true);
    setMangaInLibrary(manga.id, false)
      .then(() => {
        toast({ description: `Removed ${manga.title} from your library` });
        if (onRemoved) onRemoved();
        else router.refresh();
      })
      .catch(() => toast({ description: "Couldn't remove from library — try again" }))
      .finally(() => setRemoving(false));
  };

  const setShelf = (status: ShelfStatus) => {
    applyLibraryAction(
      libraryActions.setShelf(manga.id, status),
      "Couldn't move this title — it's been restored.",
    );
    const label = SHELF_OPTIONS.find((o) => o.value === status)?.label;
    toast({ description: `${manga.title} moved to ${label}` });
  };

  const clearShelf = () => {
    applyLibraryAction(
      libraryActions.removeShelf(manga.id),
      "Couldn't clear this shelf — it's been restored.",
    );
    toast({ description: `${manga.title} removed from its shelf — still in your library` });
  };

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        aria-label="Set shelf"
        className={`flex h-10 items-center gap-2 rounded-full border px-4 text-sm transition ${
          shelfStatus
            ? 'border-primary/50 bg-primary/10 text-primary'
            : 'border-border/60 bg-surface/60 text-foreground hover:bg-surface'
        }`}
      >
        <BookPlus className="h-4 w-4" />
        {shelfStatus
          ? (SHELF_OPTIONS.find((o) => o.value === shelfStatus)?.label ?? 'In Library')
          : 'No shelf'}
        <ChevronDown className="h-3.5 w-3.5 opacity-50" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {SHELF_OPTIONS.map((o) => (
          <DropdownMenuItem
            key={o.value}
            onSelect={() => setShelf(o.value)}
            className={o.value === shelfStatus ? 'text-primary' : ''}
          >
            {o.label}
          </DropdownMenuItem>
        ))}
        {shelfStatus && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={clearShelf}>Clear shelf</DropdownMenuItem>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={removeFromLibrary}
          disabled={removing}
          className="text-destructive"
        >
          {removing ? 'Removing…' : 'Remove from library'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function BookmarkButton({ manga }: { manga: Manga }) {
  const { bookmarks } = useLibraryState();
  const isBookmarked = bookmarks.includes(manga.id);

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
    <button
      onClick={toggleBookmark}
      aria-pressed={isBookmarked}
      aria-label={isBookmarked ? 'Remove bookmark' : 'Bookmark'}
      className={`grid h-10 w-10 place-items-center rounded-full border transition ${
        isBookmarked
          ? 'border-primary/50 bg-primary/10 text-primary'
          : 'border-border/60 bg-surface/60 text-foreground hover:bg-surface'
      }`}
    >
      <Bookmark className={`h-4 w-4 ${isBookmarked ? 'fill-current' : ''}`} />
    </button>
  );
}

function DownloadMenu({
  manga,
  knownChapters,
}: {
  manga: Manga;
  /** Chapters the caller already holds. Supplied by the source preview, which was opened
   * with the full chapter list — re-fetching it there would be a round trip for data
   * already on screen. */
  knownChapters?: MangaChapterRecord[];
}) {
  const [chapters, setChapters] = useState<MangaChapterRecord[]>(knownChapters ?? []);
  const [downloads, setDownloads] = useState<DownloadSummary[]>([]);

  useEffect(() => {
    if (knownChapters) {
      setChapters(knownChapters);
      return;
    }
    const controller = new AbortController();
    getMangaChapters(manga.id, manga.slug, manga.source, controller.signal)
      .then((rows) => {
        if (!controller.signal.aborted) setChapters(rows);
      })
      .catch((error) => {
        if (!controller.signal.aborted) reportError(error, "Couldn't load download options.");
      });
    return () => controller.abort();
  }, [manga.id, manga.slug, manga.source, knownChapters]);

  const refreshDownloads = () => {
    getAllDownloads()
      .then((all) => setDownloads(all.filter((d) => d.manga_id === manga.id)))
      .catch((error) => reportError(error, "Couldn't refresh download status."));
  };
  useEffect(refreshDownloads, [manga.id]);

  const unreadChapters = chapters.filter((c) => !c.is_read);
  // A single downloaded chapter doesn't mean the manga is available offline — the button
  // only reads as "done" once every chapter is, and shows a count while partway there.
  const completedIds = new Set(
    downloads.filter((d) => d.status === 'COMPLETED').map((d) => d.chapter_id),
  );
  const completedCount = chapters.filter((c) => completedIds.has(c.id)).length;
  const fullyDownloaded = chapters.length > 0 && completedCount === chapters.length;
  const partiallyDownloaded = completedCount > 0 && !fullyDownloaded;

  const queueDownload = (mode: 'all' | 'unread' | 'remove') => {
    if (mode === 'remove') {
      Promise.all(downloads.map((d) => cancelDownload(d.id)))
        .then(() => {
          toast({ description: `Removed downloads for ${manga.title}` });
          refreshDownloads();
          refreshDownloadStore();
        })
        .catch(() => toast({ description: "Couldn't remove downloads — try again" }));
      return;
    }
    const targets = mode === 'all' ? chapters : unreadChapters;
    if (targets.length === 0) {
      toast({ description: 'Nothing to download' });
      return;
    }
    Promise.all(
      targets.map((c) =>
        initiateDownload({
          sourceId: manga.source,
          mangaSlug: manga.slug,
          mangaTitle: manga.title,
          chapter: { id: c.id, name: c.name ?? undefined, chapter_number: c.chapter_number },
        }),
      ),
    )
      .then(() => {
        toast({
          description:
            mode === 'all'
              ? `Queued all ${chapters.length} chapters for download`
              : `Queued ${unreadChapters.length} unread chapter${unreadChapters.length === 1 ? '' : 's'} for download`,
        });
        refreshDownloads();
        refreshDownloadStore();
      })
      .catch(() => toast({ description: "Some chapters couldn't be queued — try again" }));
  };

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        aria-pressed={fullyDownloaded}
        aria-label={
          fullyDownloaded
            ? 'All chapters downloaded — download options'
            : partiallyDownloaded
              ? `${completedCount} of ${chapters.length} chapters downloaded — download options`
              : 'Download'
        }
        title={
          partiallyDownloaded
            ? `${completedCount} of ${chapters.length} chapters downloaded`
            : undefined
        }
        className={`relative grid h-10 w-10 place-items-center rounded-full border transition ${
          fullyDownloaded || partiallyDownloaded
            ? 'border-primary/50 bg-primary/10 text-primary'
            : 'border-border/60 bg-surface/60 text-foreground hover:bg-surface'
        }`}
      >
        {fullyDownloaded ? <Check className="h-4 w-4" /> : <Download className="h-4 w-4" />}
        {partiallyDownloaded && (
          <span className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[9px] font-semibold tabular-nums text-primary-foreground">
            {completedCount}
          </span>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onSelect={() => queueDownload('all')}>
          Download all chapters ({chapters.length})
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => queueDownload('unread')}>
          Download unread ({unreadChapters.length})
        </DropdownMenuItem>
        {downloads.length > 0 && (
          <DropdownMenuItem onSelect={() => queueDownload('remove')} className="text-destructive">
            Remove downloads
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ShareButton({ manga }: { manga: Manga }) {
  const share = () => {
    void shareSourceMangaLink({
      title: manga.title,
      sourceId: manga.source,
      slug: manga.slug,
    });
  };

  return (
    <button
      onClick={share}
      aria-label="Share"
      className="grid h-10 w-10 place-items-center rounded-full border border-border/60 bg-surface/60 text-foreground hover:bg-surface"
    >
      <Share2 className="h-4 w-4" />
    </button>
  );
}

/** Adds a source-backed row to the library in place. Shown instead of the shelf picker
 * for titles reached from Discover, which exist as rows but aren't library members. */
function AddToLibraryButton({ manga, onAdded }: { manga: Manga; onAdded?: () => void }) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);

  const add = () => {
    if (adding) return;
    setAdding(true);
    setMangaInLibrary(manga.id, true)
      .then(() => {
        toast({ description: `Added ${manga.title} to your library` });
        // Re-renders this page with in_library true, swapping in the shelf picker —
        // unless the caller updates in place, which avoids re-fetching the whole route.
        if (onAdded) onAdded();
        else router.refresh();
      })
      .catch(() => toast({ description: "Couldn't add to library — try again" }))
      .finally(() => setAdding(false));
  };

  return (
    <button
      onClick={add}
      disabled={adding}
      className="flex items-center gap-2 rounded-full border border-border/60 bg-surface/60 px-4 py-2.5 text-sm text-foreground transition hover:bg-surface disabled:opacity-60"
    >
      <BookPlus className="h-4 w-4" />
      {adding ? 'Adding…' : 'Add to Library'}
    </button>
  );
}

/** The action row's spacing/wrapping is owned by MangaDetailLayout, so this returns the
 * buttons themselves rather than another flex container. */
export function MangaActionBar({
  manga,
  onAdded,
  onRemoved,
  knownChapters,
}: {
  manga: Manga;
  /** Supplied by callers that update in place instead of relying on a route refresh. */
  onAdded?: () => void;
  onRemoved?: () => void;
  /** Chapters the caller already has, to skip a redundant fetch. */
  knownChapters?: MangaChapterRecord[];
}) {
  return (
    <>
      <ContinueReadingLink manga={manga} />
      {/* A shelf only means something once the title is actually in the library. */}
      {manga.inLibrary ? (
        <ShelfMenu manga={manga} onRemoved={onRemoved} />
      ) : (
        <AddToLibraryButton manga={manga} onAdded={onAdded} />
      )}
      <BookmarkButton manga={manga} />
      <DownloadMenu manga={manga} knownChapters={knownChapters} />
      <TrackerLinkButton manga={manga} />
      {manga.inLibrary && <SourceSwitch manga={manga} />}
      <ShareButton manga={manga} />
    </>
  );
}
