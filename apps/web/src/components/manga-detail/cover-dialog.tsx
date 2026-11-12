'use client';

import { useRef, useState, type ChangeEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Download, ImageUp, RotateCcw, X } from 'lucide-react';
import { removeMangaCover, uploadMangaCover } from '@projekt-manga/api-client';
import { MANGA_COVER_MIME_TYPES } from '@projekt-manga/schemas';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { MangaCover } from '@/components/manga-card';
import { toast } from '@/hooks/use-toast';
import { coverFileName, coverFileProblem } from '@/lib/cover-file';
import { queryClient, queryKeys } from '@/lib/query-client';
import type { Manga } from '@/lib/manga-data';

const actionClass =
  'inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-black/55 px-3.5 py-2 text-xs font-medium text-white backdrop-blur transition hover:bg-black/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50';

/**
 * Cover art that opens a larger view when clicked, where the cover can be saved and, for a
 * title in the library, changed. The close button sits outside the picture so it never
 * covers the art.
 */
export function MangaCoverDialog({ manga }: { manga: Manga }) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState<'save' | 'change' | 'reset' | null>(null);
  // Only a title in the library has a local row a custom cover can belong to.
  const editable = manga.editable;
  const hasCustomCover = editable?.override?.has_cover === true;

  const saveCover = async () => {
    if (!manga.thumbnailUrl) return;
    setBusy('save');
    try {
      const response = await fetch(manga.thumbnailUrl, { credentials: 'include' });
      if (!response.ok) throw new Error(String(response.status));
      const image = await response.blob();
      const href = URL.createObjectURL(image);
      const link = document.createElement('a');
      link.href = href;
      link.download = coverFileName(manga.title, image.type);
      document.body.append(link);
      link.click();
      link.remove();
      // Late enough for the download to have read it.
      setTimeout(() => URL.revokeObjectURL(href), 10_000);
    } catch {
      toast({ description: "Couldn't save the cover — try again." });
    } finally {
      setBusy(null);
    }
  };

  const changed = (message: string) => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.mangaLibrary });
    router.refresh();
    toast({ description: message });
  };

  const chooseCover = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const problem = coverFileProblem(file);
    if (problem) {
      toast({ description: problem });
      return;
    }
    setBusy('change');
    try {
      await uploadMangaCover(manga.id, file);
      changed('Cover changed. Only you see it; the source’s cover stays underneath.');
    } catch (error) {
      toast({
        description:
          error instanceof Error && error.message
            ? `Couldn't change the cover: ${error.message}`
            : "Couldn't change the cover — try again.",
      });
    } finally {
      setBusy(null);
    }
  };

  const restoreSourceCover = async () => {
    setBusy('reset');
    try {
      await removeMangaCover(manga.id);
      changed('Showing the source’s cover again.');
    } catch {
      toast({ description: "Couldn't restore the source’s cover — try again." });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          className="block w-full max-w-[220px] cursor-zoom-in text-left transition hover:opacity-90"
          aria-label={`View cover for ${manga.title}`}
        >
          <MangaCover manga={manga} chapterBadge={false} statusBadge={false} />
        </button>
      </DialogTrigger>
      <DialogContent
        hideClose
        className="w-[min(26rem,calc(100vw-2rem),calc((100dvh-10rem)*2/3))] max-w-none gap-3 border-none bg-transparent p-0 shadow-none"
      >
        <DialogTitle className="sr-only">{manga.title} cover</DialogTitle>
        <DialogDescription className="sr-only">
          The cover at a larger size, with options to save
          {editable ? ' or change' : ''} it.
        </DialogDescription>
        {/* Above the picture's corner, never over the art. */}
        <div className="flex justify-end">
          <DialogClose
            aria-label="Close cover"
            className="grid size-9 place-items-center rounded-full border border-white/15 bg-black/55 text-white backdrop-blur transition hover:bg-black/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-4" aria-hidden="true" />
          </DialogClose>
        </div>
        <div data-testid="cover-viewer-image">
          <MangaCover manga={manga} chapterBadge={false} statusBadge={false} />
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            className={actionClass}
            disabled={!manga.thumbnailUrl || busy !== null}
            onClick={() => void saveCover()}
          >
            <Download className="size-3.5" aria-hidden="true" />
            {busy === 'save' ? 'Saving…' : 'Save image'}
          </button>
          {editable && (
            <>
              <input
                ref={fileInput}
                type="file"
                accept={MANGA_COVER_MIME_TYPES.join(',')}
                className="sr-only"
                aria-label="Choose a new cover image"
                tabIndex={-1}
                onChange={(event) => void chooseCover(event)}
              />
              <button
                type="button"
                className={actionClass}
                disabled={busy !== null}
                onClick={() => fileInput.current?.click()}
              >
                <ImageUp className="size-3.5" aria-hidden="true" />
                {busy === 'change' ? 'Changing…' : 'Change cover…'}
              </button>
              {hasCustomCover && (
                <button
                  type="button"
                  className={actionClass}
                  disabled={busy !== null}
                  onClick={() => void restoreSourceCover()}
                >
                  <RotateCcw className="size-3.5" aria-hidden="true" />
                  {busy === 'reset' ? 'Restoring…' : 'Use source cover'}
                </button>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
