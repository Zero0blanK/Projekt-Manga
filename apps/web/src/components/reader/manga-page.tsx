import { useEffect, useState } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import type { Manga } from '@/lib/manga-data';

export function MangaPage({
  manga,
  pageNumber,
  totalPages,
  imageUrl,
  className,
  /** Which dimension `className` constrains, so the other can size to the real image's
   * aspect ratio instead of being locked into a portrait guess — real pages range from
   * tall single pages to wide double-page spreads. "fixed" means className sets both. */
  fit = 'height',
  seamless = false,
  onReady,
}: {
  manga: Manga;
  pageNumber: number;
  totalPages: number;
  /** Real page image URL (already routed through the server's image proxy), when known. */
  imageUrl?: string;
  className?: string;
  fit?: 'width' | 'height' | 'fixed';
  /** Webtoon-style: no rounded corners or border, so adjacent pages butt together. */
  seamless?: boolean;
  onReady?: () => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setLoaded(false);
    setFailed(false);
    setAttempt(0);
  }, [manga.id, pageNumber, imageUrl]);

  if (!imageUrl) {
    return (
      <Skeleton className={cn('aspect-2/3 bg-white/10', !seamless && 'rounded-lg', className)} />
    );
  }

  const imgSizeClass =
    fit === 'fixed'
      ? 'h-full w-full'
      : fit === 'width'
        ? 'w-full h-auto max-h-full'
        : 'h-full w-auto max-w-full';

  return (
    <div
      className={cn(
        'relative overflow-hidden',
        // Until the real image loads (and we know its actual aspect ratio), hold a
        // guessed portrait box so layout doesn't collapse to zero size; once loaded,
        // drop it so the box reflows to the image's real shape instead of letterboxing.
        !loaded && 'aspect-2/3',
        // Borders are skipped in seamless mode: adjacent borders would draw a visible line
        // between pages. The bordered, rounded card look is for the spaced modes.
        seamless ? '' : 'rounded-lg border border-white/5',
        className,
      )}
    >
      {!loaded && !failed && (
        <Skeleton className={cn('absolute inset-0 bg-white/10', !seamless && 'rounded-lg')} />
      )}
      {failed && (
        <div
          role="alert"
          className="absolute inset-0 z-10 grid place-content-center gap-3 bg-black/90 p-4 text-center text-sm text-white"
        >
          <p>Page {pageNumber} could not load.</p>
          <button
            type="button"
            className="rounded border border-white/30 px-4 py-2"
            onClick={() => {
              setFailed(false);
              setLoaded(false);
              setAttempt((value) => value + 1);
            }}
          >
            Retry page {pageNumber}
          </button>
        </div>
      )}
      {/* eslint-disable-next-line @next/next/no-img-element -- arbitrary external hosts via the server's image proxy */}
      <img
        key={attempt}
        src={imageUrl}
        alt={`${manga.title} — page ${pageNumber} of ${totalPages}`}
        onLoad={() => {
          setLoaded(true);
          setFailed(false);
          onReady?.();
        }}
        onError={() => {
          setFailed(true);
          setLoaded(false);
        }}
        loading={seamless ? 'lazy' : 'eager'}
        className={cn(imgSizeClass, 'object-contain')}
      />
    </div>
  );
}
