'use client';

import { useParams } from 'next/navigation';
import { Cover } from '@/components/cover';
import { MangaDetailBackLink } from '@/components/manga-detail/back-link';
import { ChapterListSkeleton, MangaDetailHeaderSkeleton } from '@/components/skeletons';
import { Skeleton } from '@/components/ui/skeleton';
import { sourcePreviewSeed } from '@/lib/source-preview-seed';
import { decodeSourceRouteId } from '@/lib/source-route-id';

/**
 * The source title page while its details are still being read from the source.
 *
 * Opened from a source card, the title and cover that card showed appear at once, in the
 * places the finished page puts them, with placeholders only for what the source has yet
 * to send (credits, genres, synopsis, actions, chapters). Without a card to go on (a
 * reload, a link), it is the plain skeleton.
 */
export function SourcePreviewShell() {
  const params = useParams<{ sourceId: string; mangaId: string }>();
  // Route params arrive decoded apart from path delimiters (lib/source-route-id.ts).
  const sourceId = params?.sourceId ? decodeSourceRouteId(params.sourceId) : '';
  const mangaId = params?.mangaId ? decodeSourceRouteId(params.mangaId) : '';
  const seed = sourceId && mangaId ? sourcePreviewSeed(sourceId, mangaId) : null;
  if (!seed) return <MangaDetailHeaderSkeleton />;

  return (
    <div className="relative" aria-busy="true">
      <div className="relative mx-auto max-w-6xl px-4 py-6 sm:px-8">
        <MangaDetailBackLink fallbackHref="/discover" fallbackLabel="Discover" />
        {/* The same grid as MangaDetailLayout, so nothing moves when the details arrive. */}
        <div className="mt-6 grid grid-cols-[7rem_minmax(0,1fr)] items-start gap-x-4 gap-y-2 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-x-6 md:grid-cols-[220px_minmax(0,1fr)] md:gap-x-8">
          <div className="md:row-span-2">
            <div className="relative aspect-[2/3] w-full max-w-[220px] overflow-hidden rounded-xl shadow-cover">
              <Cover
                sourceId={sourceId}
                src={seed.thumbnailUrl}
                alt={seed.title}
                rounded="rounded-xl"
                className="absolute inset-0 h-full w-full"
              />
            </div>
          </div>

          <div className="min-w-0">
            <Skeleton className="h-3 w-20" />
            <h1 className="mt-2 text-display text-2xl leading-[1.05] text-foreground sm:text-4xl md:text-5xl md:leading-[1.02]">
              {seed.title}
            </h1>
            <Skeleton className="mt-3 h-4 w-1/2" />
          </div>

          <div className="col-span-2 min-w-0 space-y-3 md:col-span-1 md:col-start-2">
            <p role="status" className="text-xs text-muted-foreground">
              Loading details from the source…
            </p>
            <div className="flex flex-wrap gap-1.5">
              {Array.from({ length: 5 }, (_, i) => (
                <Skeleton key={i} className="h-5 w-16 rounded-full" />
              ))}
            </div>
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <div className="flex flex-wrap items-center gap-2 pt-3">
              <Skeleton className="h-10 w-36 rounded-full" />
              <Skeleton className="h-10 w-10 rounded-full" />
              <Skeleton className="h-10 w-10 rounded-full" />
            </div>
          </div>
        </div>
        <ChapterListSkeleton />
      </div>
    </div>
  );
}
