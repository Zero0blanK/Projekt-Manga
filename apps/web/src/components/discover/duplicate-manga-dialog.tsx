'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Mangas, MangaDetails } from '@projekt-manga/types';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { MatchRow } from '@/components/discover/duplicate-match-row';
import { toast } from '@/hooks/use-toast';
import { findLibraryDuplicates, type DuplicateMatch } from '@/lib/duplicate-detection';
import { migrateManga, describeMigration } from '@/lib/migrate-manga';
import { addSourceMangaToLibrary } from '@/lib/discover-actions';
import { useMangaLibrary } from '@/lib/library-store';

/**
 * "You may already have this" — shown when a title being added from a source looks like
 * one already in the library.
 *
 * Deliberately a question, not a block. Title matching across sources can't be certain
 * (see lib/duplicate-detection), and a sequel sharing a stem with its parent series is a
 * legitimate second entry — so every path stays open and the reader decides.
 */

interface PendingAdd {
  sourceId: string;
  item: Mangas;
  details?: MangaDetails;
  matches: DuplicateMatch[];
}

/**
 * Wraps "add this source title to the library" with a duplicate check.
 *
 * Returns the trigger to call in place of a direct add, and the dialog element to render.
 * Both add entry points (the preview page and the Discover grid card) use this so the
 * check can't be present on one and missing on the other.
 */
export function useDuplicateCheckedAdd(onAdded?: (mangaId: string) => void) {
  const router = useRouter();
  const { manga: library, refresh } = useMangaLibrary();
  const [pending, setPending] = useState<PendingAdd | null>(null);
  const [busy, setBusy] = useState(false);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (pending || !restoreFocusRef.current) return;
    const target = restoreFocusRef.current;
    restoreFocusRef.current = null;
    if (target.isConnected) target.focus();
  }, [pending]);

  /** Adds directly when nothing looks like a duplicate, otherwise opens the dialog.
   * Resolves to the new manga id, or null when the reader was asked instead. */
  const requestAdd = async (
    sourceId: string,
    item: Mangas,
    details?: MangaDetails,
  ): Promise<string | null> => {
    const matches = findLibraryDuplicates(item.title, library, {
      excludeSource: sourceId,
      excludeSlug: item.slug || item.id,
    });

    if (matches.length === 0) {
      const id = await addSourceMangaToLibrary(sourceId, item, details);
      onAdded?.(id);
      void refresh();
      return id;
    }

    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPending({ sourceId, item, details, matches });
    return null;
  };

  const close = () => {
    if (!busy) setPending(null);
  };

  const addAnyway = () => {
    if (!pending) return;
    setBusy(true);
    addSourceMangaToLibrary(pending.sourceId, pending.item, pending.details)
      .then((id) => {
        toast({ description: `Added "${pending.item.title}" to your library` });
        onAdded?.(id);
        void refresh();
        setPending(null);
      })
      .catch(() => toast({ description: `Couldn't add "${pending.item.title}".` }))
      .finally(() => setBusy(false));
  };

  const showEntry = (match: DuplicateMatch) => {
    setPending(null);
    router.push(`/manga/${encodeURIComponent(match.manga.id)}`);
  };

  /**
   * Migration needs the new title to exist as a row first — everything transferred is
   * keyed on its manga_id — so this adds it, then moves the reading state across, then
   * retires the old entry.
   */
  const migrate = (match: DuplicateMatch) => {
    if (!pending) return;
    setBusy(true);

    (async () => {
      const newId = await addSourceMangaToLibrary(pending.sourceId, pending.item, pending.details);

      // Everything after this point is one server-side transaction — the old entry's
      // shelf, rating, progress, categories and history are read and moved there, so
      // there is nothing to gather here first.
      const result = await migrateManga({
        from: {
          mangaId: match.manga.id,
          slug: match.manga.slug,
          title: match.manga.title,
        },
        to: {
          mangaId: newId,
          slug: pending.item.slug || pending.item.id,
          title: pending.item.title,
        },
        removeOld: true,
      });

      toast({ description: describeMigration(result, pending.item.title) });
      onAdded?.(newId);
      void refresh();
      setPending(null);
    })()
      .catch(() => toast({ description: `Couldn't migrate "${pending.item.title}".` }))
      .finally(() => setBusy(false));
  };

  const dialog = (
    <Dialog open={pending !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Already in your library?</DialogTitle>
          <DialogDescription>
            {pending?.matches.length === 1
              ? `"${pending?.item.title}" looks like a title you already have.`
              : `"${pending?.item.title}" looks like ${pending?.matches.length} titles you already have.`}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-72 space-y-2 overflow-y-auto">
          {pending?.matches.map((match) => (
            <MatchRow
              key={match.manga.id}
              match={match}
              busy={busy}
              onShow={() => showEntry(match)}
              onMigrate={() => migrate(match)}
            />
          ))}
        </div>

        <p className="text-xs text-muted-foreground">
          Migrating carries your reading progress, shelf, rating, categories and history over to the
          new source, then removes the old entry from your library. It happens in one step — it
          either all transfers or none of it does.
        </p>

        <div className="flex justify-end gap-2">
          <button
            onClick={close}
            disabled={busy}
            className="rounded-lg border border-border/60 px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-accent disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={addAnyway}
            disabled={busy}
            className="rounded-lg border border-border/60 px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-accent disabled:opacity-50"
          >
            {busy ? 'Working…' : 'Add anyway'}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );

  return { requestAdd, dialog, busy };
}
