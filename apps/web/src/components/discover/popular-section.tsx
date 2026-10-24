'use client';

import { useState } from 'react';
import Link from 'next/link';
import { toast } from '@/hooks/use-toast';
import type { Mangas } from '@projekt-manga/types';
import { useDuplicateCheckedAdd } from '@/components/discover/duplicate-manga-dialog';
import { buildImageProxyUrl } from '@projekt-manga/api-client';
import { useMangaLibrary } from '@/lib/library-store';
import { Cover, GRID_COVER_SIZES } from '@/components/cover';
import { Check, Plus } from 'lucide-react';

export function SourceResultCard({ sourceId, item }: { sourceId: string; item: Mangas }) {
  const [adding, setAdding] = useState(false);
  const [justAdded, setJustAdded] = useState(false);
  const { manga: library } = useMangaLibrary();
  // Routed through the duplicate check rather than adding straight away — the same guard
  // the preview page uses, so it can't be present on one add path and missing here.
  const { requestAdd, dialog } = useDuplicateCheckedAdd(() => setJustAdded(true));

  // A title added in an earlier session (or from its preview page) must read as "In
  // library" here too, so this is derived from the library rather than local add state.
  // Sources identify a title by the same value that becomes its slug, which is what the
  // library stores.
  const alreadyInLibrary = library.some(
    (m) => m.source === sourceId && m.inLibrary && (m.slug === item.slug || m.slug === item.id),
  );
  const added = alreadyInLibrary || justAdded;

  // Stays put rather than navigating away — adding from a grid shouldn't cost you your
  // place in it.
  const add = () => {
    if (added || adding) return;
    setAdding(true);
    requestAdd(sourceId, item)
      .then((id) => {
        // null means a possible duplicate was found and the dialog is now asking — the
        // toast belongs to whichever action the reader picks there, not to this call.
        if (id !== null) toast({ description: `Added "${item.title}" to your library` });
      })
      .catch(() =>
        toast({ description: `Couldn't add "${item.title}" — it may already be in your library.` }),
      )
      .finally(() => setAdding(false));
  };

  const thumbnailUrl = item.thumbnail_url
    ? buildImageProxyUrl(item.thumbnail_url, item.source)
    : null;
  const previewHref = `/discover/preview/${encodeURIComponent(sourceId)}/${encodeURIComponent(item.id)}`;

  return (
    <div className="group relative flex flex-col gap-3">
      {dialog}
      <Link
        href={previewHref}
        aria-label={`Preview "${item.title}"`}
        className="relative block aspect-2/3 w-full overflow-hidden rounded-xl shadow-cover outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <Cover
          sourceId={sourceId}
          src={thumbnailUrl}
          alt={item.title}
          rounded="rounded-xl"
          sizes={GRID_COVER_SIZES}
          className="absolute inset-0 h-full w-full"
        />
      </Link>

      {/* Sits outside the Link so adding never navigates; nesting a button inside an anchor
          would swallow one of the two. `pointer-events-none` while hidden is required: a
          transparent button still captures clicks and would block the cover's top-right
          corner. */}
      <button
        onClick={add}
        disabled={added || adding}
        aria-label={added ? `"${item.title}" is in your library` : `Add "${item.title}" to library`}
        className={`pointer-events-none absolute right-2 top-2 z-10 flex items-center gap-1 rounded-full px-2.5 py-1.5 text-xs font-medium backdrop-blur transition focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100 ${
          added
            ? 'bg-primary/90 text-primary-foreground opacity-100'
            : 'bg-background/85 text-foreground opacity-0 hover:bg-background'
        }`}
      >
        {added ? (
          <>
            <Check className="h-3.5 w-3.5" /> In library
          </>
        ) : (
          <>
            <Plus className="h-3.5 w-3.5" /> Add
          </>
        )}
      </button>

      <Link
        href={previewHref}
        className="line-clamp-2 text-sm font-semibold text-foreground transition hover:text-primary"
      >
        {item.title}
      </Link>
    </div>
  );
}
