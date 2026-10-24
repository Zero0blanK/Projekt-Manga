import { Skeleton } from '@/components/ui/skeleton';
import { MangaGrid } from '@/components/manga-grid';

/**
 * Shared skeleton placeholders for every page's initial (client-side) loading state.
 *
 * Kept in one file rather than inlined per page so the shapes stay consistent — a grid
 * of covers looks the same whether it's the library, bookmarks, recents or a discover
 * browse page loading. Each one mirrors the real component's layout closely enough that
 * the swap-in doesn't shift the page.
 */

/** Placeholder for a grid of `MangaCard`s — library, bookmarks, recents, discover browse. */
export function MangaGridSkeleton({ count = 12 }: { count?: number }) {
  return (
    <MangaGrid>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex flex-col gap-3">
          <Skeleton className="aspect-2/3 w-full rounded-xl" />
          <div className="space-y-1.5 px-0.5">
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        </div>
      ))}
    </MangaGrid>
  );
}

/** Placeholder for a `RowList` of thumbnail + text rows — history, recents, chapter
 * updates, and the library's list view. */
export function RowListSkeleton({
  count = 6,
  thumbnail = true,
}: {
  count?: number;
  /** Some rows (update log entries) have no cover art at all. */
  thumbnail?: boolean;
}) {
  return (
    <ul className="divide-y divide-border/60 overflow-hidden rounded-2xl border border-border/60 bg-surface/40">
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className="flex items-center gap-4 p-4">
          {thumbnail && <Skeleton className="h-16 w-12 shrink-0 rounded-md" />}
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3.5 w-1/2" />
            <Skeleton className="h-3 w-1/3" />
          </div>
          <Skeleton className="h-7 w-16 shrink-0 rounded-full" />
        </li>
      ))}
    </ul>
  );
}

/** Placeholder for the chapter list on a manga detail page — same row height as
 * `ChapterListItem`/`SourceChapterList`'s rows, so chapters popping in doesn't jump. */
export function ChapterListSkeleton({ count = 8 }: { count?: number }) {
  return (
    <ul className="mt-4 divide-y divide-border/50 overflow-hidden rounded-xl border border-border/60 bg-surface/40">
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className="flex items-center gap-4 px-4 py-3">
          <Skeleton className="h-9 w-9 shrink-0 rounded-lg" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-2/5" />
            <Skeleton className="h-2.5 w-1/5" />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Placeholder for a row of `StatCard`s — Settings > Statistics, Downloads storage. */
export function StatCardsSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="rounded-xl border border-border/60 bg-background/40 p-4">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="mt-3 h-7 w-12" />
          <Skeleton className="mt-2 h-2.5 w-20" />
        </div>
      ))}
    </div>
  );
}

/** Placeholder for a Discover browse page (Popular/Latest) before its client component
 * has mounted — used as the `loading.tsx`-equivalent Suspense fallback for the
 * `useSearchParams()` boundary those pages need. */
export function BrowsePageSkeleton() {
  return (
    <div className="min-w-0 px-8 py-6">
      <Skeleton className="h-4 w-24" />
      <div className="mt-5 flex flex-wrap items-end justify-between gap-4">
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-9 w-40 rounded-full" />
      </div>
      <div className="mt-8">
        <MangaGridSkeleton />
      </div>
    </div>
  );
}

/** Placeholder for the source cards grid on Discover's landing page. */
export function SourceCardsSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="overflow-hidden rounded-2xl border border-border/60 bg-surface/40">
          <div className="flex items-center gap-3 p-5">
            <Skeleton className="h-12 w-12 shrink-0 rounded-2xl" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-2.5 w-1/3" />
            </div>
          </div>
          <div className="divide-y divide-border/60 border-t border-border/60">
            <div className="p-3">
              <Skeleton className="h-4 w-24" />
            </div>
            <div className="p-3">
              <Skeleton className="h-4 w-24" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Placeholder for the manga detail header (cover + title + credits + stats + action
 * row) — used by `loading.tsx` for the manga detail, source preview and reader routes,
 * which each `await` a server-side fetch before they can render the real thing.
 */
export function MangaDetailHeaderSkeleton() {
  return (
    <div className="relative mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
      <Skeleton className="h-7 w-24 rounded-full" />
      <div className="mt-6 flex flex-col items-start gap-8 md:flex-row">
        <Skeleton className="aspect-2/3 w-full max-w-[220px] shrink-0 rounded-xl" />
        <div className="w-full flex-1 space-y-3">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-10 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-1/3" />
          <div className="flex flex-wrap gap-1.5 pt-2">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-5 w-16 rounded-full" />
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2 pt-4">
            <Skeleton className="h-10 w-36 rounded-full" />
            <Skeleton className="h-10 w-10 rounded-full" />
            <Skeleton className="h-10 w-10 rounded-full" />
            <Skeleton className="h-10 w-10 rounded-full" />
          </div>
        </div>
      </div>
      <ChapterListSkeleton />
    </div>
  );
}

/** Placeholder for the fixed-position reader chrome (header bar + page area) — used by
 * `loading.tsx` for /reader/[id] and the source-preview reader while the manga/chapter
 * metadata is still being fetched server-side. */
export function ReaderSkeleton() {
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black">
      <div className="flex h-14 shrink-0 items-center gap-4 border-b border-white/10 bg-black/80 px-4">
        <Skeleton className="h-9 w-9 rounded-lg bg-white/10" />
        <div className="min-w-0 space-y-1.5">
          <Skeleton className="h-3.5 w-40 bg-white/10" />
          <Skeleton className="h-2.5 w-24 bg-white/10" />
        </div>
      </div>
      <div className="flex flex-1 items-center justify-center">
        <Skeleton className="h-[70vh] w-[46vh] bg-white/10" />
      </div>
    </div>
  );
}
