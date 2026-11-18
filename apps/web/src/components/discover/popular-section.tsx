'use client';

import { useEffect, useState } from 'react';
import { reportError } from '@/lib/report-error';
import Link, { useLinkStatus } from 'next/link';
import { toast } from '@/hooks/use-toast';
import type { Mangas } from '@projekt-manga/types';
import { useDuplicateCheckedAdd } from '@/components/discover/duplicate-manga-dialog';
import { buildImageProxyUrl } from '@projekt-manga/api-client';
import { useMangaLibrary } from '@/lib/library-store';
import { isInLibrary } from '@/lib/library-titles';
import { Cover } from '@/components/cover';
import { Check, Loader2, Plus } from 'lucide-react';
import { rememberSourcePreview } from '@/lib/source-preview-seed';

/** After this long still opening, the card says the connection is slow. */
export const SLOW_OPEN_MS = 4000;

/**
 * Reports whether the `<Link>` it sits in is navigating. On a slow connection the title
 * page's loading screen may not have been prefetched yet, so the router waits for the
 * server before anything changes; this lets the card show that the click was taken.
 */
function LinkPending({ onChange }: { onChange: (pending: boolean) => void }) {
  const { pending } = useLinkStatus();
  useEffect(() => onChange(pending), [pending, onChange]);
  return null;
}

/**
 * Over the cover while its title page opens. Always rendered, so nothing shifts; it fades
 * in only after a short delay (`.link-pending` in styles.css), so a fast open never flashes.
 */
function OpeningOverlay({ opening }: { opening: boolean }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!opening) {
      setSlow(false);
      return;
    }
    const timer = window.setTimeout(() => setSlow(true), SLOW_OPEN_MS);
    return () => window.clearTimeout(timer);
  }, [opening]);

  return (
    <div
      className={`link-pending pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-xl bg-background/70 p-3 text-center backdrop-blur-[2px] ${
        opening ? 'is-pending' : ''
      }`}
    >
      {opening && (
        <>
          <Loader2 className="h-6 w-6 animate-spin text-foreground" aria-hidden />
          <span role="status" className="text-xs font-medium text-foreground">
            {slow ? 'Slow connection, still opening…' : 'Opening…'}
          </span>
        </>
      )}
    </div>
  );
}

export function SourceResultCard({ sourceId, item }: { sourceId: string; item: Mangas }) {
  const [adding, setAdding] = useState(false);
  const [justAdded, setJustAdded] = useState(false);
  // Either of the card's two links (cover or title) being clicked opens the same page.
  const [coverOpening, setCoverOpening] = useState(false);
  const [titleOpening, setTitleOpening] = useState(false);
  const opening = coverOpening || titleOpening;
  const { manga: library } = useMangaLibrary();
  // Routed through the duplicate check rather than adding straight away — the same guard
  // the preview page uses, so it can't be present on one add path and missing here.
  const { requestAdd, dialog } = useDuplicateCheckedAdd(() => setJustAdded(true));

  // A title added in an earlier session (or from its preview page) must read as "In
  // library" here too, so this is derived from the library rather than local add state.
  const alreadyInLibrary = isInLibrary(library, sourceId, item);
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
      // The real reason (offline, the server's own "already in your library"), not a guess.
      .catch((error: unknown) => reportError(error, `Couldn't add "${item.title}".`))
      .finally(() => setAdding(false));
  };

  const thumbnailUrl = item.thumbnail_url
    ? buildImageProxyUrl(item.thumbnail_url, item.source)
    : null;
  const previewHref = `/discover/preview/${encodeURIComponent(sourceId)}/${encodeURIComponent(item.id)}`;
  // The title page shows this card's title and cover while the source sends the rest.
  const seedPreview = () =>
    rememberSourcePreview(sourceId, item.id, { title: item.title, thumbnailUrl });

  return (
    <div className="group relative flex flex-col gap-3">
      {dialog}
      <Link
        href={previewHref}
        onClick={seedPreview}
        aria-label={`Preview "${item.title}"`}
        aria-busy={opening || undefined}
        className="relative block aspect-2/3 w-full overflow-hidden rounded-xl shadow-cover outline-none transition-transform active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-primary"
      >
        <Cover
          sourceId={sourceId}
          src={thumbnailUrl}
          alt={item.title}
          rounded="rounded-xl"
          className="absolute inset-0 h-full w-full"
        />
        <OpeningOverlay opening={opening} />
        <LinkPending onChange={setCoverOpening} />
      </Link>

      {/* Sits outside the Link so adding never navigates; nesting a button inside an anchor
          would swallow one of the two. `pointer-events-none` while hidden is required: a
          transparent button still captures clicks and would block the cover's top-right
          corner. */}
      <button
        type="button"
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
        onClick={seedPreview}
        aria-busy={opening || undefined}
        className="line-clamp-2 text-sm font-semibold text-foreground transition hover:text-primary"
      >
        {item.title}
        <LinkPending onChange={setTitleOpening} />
      </Link>
    </div>
  );
}
