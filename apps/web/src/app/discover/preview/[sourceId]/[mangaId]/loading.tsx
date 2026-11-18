import { Suspense } from 'react';
import { Loader2 } from 'lucide-react';
import { SourcePreviewShell } from '@/components/discover/source-preview-shell';
import { MangaDetailHeaderSkeleton } from '@/components/skeletons';

/** Shown while the preview page's own server-side fetch (getSourceMangaDetails, a live
 * scrape) is in flight — this can take noticeably longer than a database read. Opened from
 * a source card, it already shows that card's title and cover; the rest streams in.
 *
 * The shell is a client component, so its code has to download before it can show. On a
 * slow connection that left the page blank for a moment, so until then this shows the
 * server-rendered skeleton, which needs no code of its own. */
export default function Loading() {
  return (
    <Suspense
      fallback={
        <>
          <div className="mx-auto max-w-6xl px-4 pt-4 sm:px-8">
            <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
              Loading details from the source…
            </p>
          </div>
          <MangaDetailHeaderSkeleton />
        </>
      }
    >
      <SourcePreviewShell />
    </Suspense>
  );
}
