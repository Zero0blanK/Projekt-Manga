'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { Chapters } from '@projekt-manga/types';
import { initiateDownload } from '@projekt-manga/api-client';
import { toast } from '@/hooks/use-toast';
import { libraryActions, useLibraryState } from '@/lib/library-store';
import { refreshDownloads } from '@/components/downloads/row-data';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Play, Bookmark, BookPlus, Share2, Download, Check } from 'lucide-react';
import { shareSourceMangaLink } from '@/lib/source-url';

/**
 * Action row for a source title that isn't in the library yet. Same shape as
 * `MangaActionBar` — read, library, bookmark, download, share — so adding a title doesn't
 * rearrange the page under you.
 *
 * Bookmark and download both need a `manga_id`, which a source title doesn't have. Rather
 * than creating a row on arrival (viewing a title must not put anything in the database),
 * `ensureRow` creates it lazily on first use, outside the library (`in_library=false`) —
 * the same shadow-row trick per-chapter downloads already use.
 */
export function SourceActionBar({
  mangaId,
  sourceId,
  mangaSlug,
  sourceUrl,
  title,
  chapters,
  readChapterIds,
  firstChapterHref,
  resuming,
  onAdd,
  adding,
  checking,
  ensureRow,
}: {
  /** Shadow-row id, once one exists. Null until something needs it. */
  mangaId: string | null;
  sourceId: string;
  mangaSlug: string;
  /** The title's page on the source site, when the source reported one. */
  sourceUrl?: string;
  title: string;
  chapters: Chapters[];
  readChapterIds: Set<string>;
  firstChapterHref: string | null;
  resuming: boolean;
  onAdd: () => void;
  adding: boolean;
  checking: boolean;
  /** Creates (or returns) the shadow row, resolving to its id. */
  ensureRow: () => Promise<string>;
}) {
  const { bookmarks } = useLibraryState();
  const [busy, setBusy] = useState(false);
  const isBookmarked = mangaId !== null && bookmarks.includes(mangaId);

  const unread = chapters.filter((c) => !readChapterIds.has(c.id));

  const toggleBookmark = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const id = mangaId ?? (await ensureRow());
      await libraryActions.toggleBookmark(id);
      toast({
        description: isBookmarked ? `Removed ${title} from bookmarks` : `Bookmarked ${title}`,
      });
    } catch {
      toast({ description: "Couldn't update bookmark — try again" });
    } finally {
      setBusy(false);
    }
  };

  const queueDownload = async (mode: 'all' | 'unread') => {
    const targets = mode === 'all' ? chapters : unread;
    if (targets.length === 0) {
      toast({ description: 'Nothing to download' });
      return;
    }
    setBusy(true);
    try {
      await ensureRow();
      await Promise.all(
        targets.map((c) =>
          initiateDownload({
            sourceId,
            mangaSlug,
            mangaTitle: title,
            chapter: { id: c.id, name: c.name || undefined, chapter_number: c.chapter_number },
          }),
        ),
      );
      refreshDownloads();
      toast({ description: `Queued ${targets.length} chapters for download` });
    } catch {
      toast({ description: "Some chapters couldn't be queued — try again" });
    } finally {
      setBusy(false);
    }
  };

  const share = () => {
    void shareSourceMangaLink({ title, sourceId, slug: mangaSlug, knownUrl: sourceUrl });
  };

  return (
    <>
      {firstChapterHref && (
        <Link
          href={firstChapterHref}
          className="flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground shadow-glow transition hover:opacity-90"
        >
          <Play className="h-4 w-4 fill-current" /> {resuming ? 'Resume Reading' : 'Start Reading'}
        </Link>
      )}

      <button
        onClick={onAdd}
        disabled={adding || checking}
        className="flex items-center gap-2 rounded-full border border-border/60 bg-surface/60 px-4 py-2.5 text-sm text-foreground transition hover:bg-surface disabled:opacity-60"
      >
        {adding ? <Check className="h-4 w-4" /> : <BookPlus className="h-4 w-4" />}
        {checking ? 'Checking…' : adding ? 'Adding…' : 'Add to Library'}
      </button>

      <button
        onClick={toggleBookmark}
        disabled={busy}
        aria-pressed={isBookmarked}
        aria-label={isBookmarked ? 'Remove bookmark' : 'Bookmark'}
        className={`grid h-10 w-10 place-items-center rounded-full border transition disabled:opacity-60 ${
          isBookmarked
            ? 'border-primary/50 bg-primary/10 text-primary'
            : 'border-border/60 bg-surface/60 text-foreground hover:bg-surface'
        }`}
      >
        <Bookmark className={`h-4 w-4 ${isBookmarked ? 'fill-current' : ''}`} />
      </button>

      <DropdownMenu modal={false}>
        <DropdownMenuTrigger
          aria-label="Download"
          disabled={busy}
          className="grid h-10 w-10 place-items-center rounded-full border border-border/60 bg-surface/60 text-foreground transition hover:bg-surface disabled:opacity-60"
        >
          <Download className="h-4 w-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onSelect={() => void queueDownload('all')}>
            Download all chapters ({chapters.length})
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void queueDownload('unread')}>
            Download unread ({unread.length})
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <button
        onClick={share}
        aria-label="Share"
        className="grid h-10 w-10 place-items-center rounded-full border border-border/60 bg-surface/60 text-foreground hover:bg-surface"
      >
        <Share2 className="h-4 w-4" />
      </button>
    </>
  );
}
