'use client';

import { Children, useEffect, useRef, useState, type ReactNode } from 'react';
import { useSetting } from '@/lib/app-store';

/** Settings > Appearance > Library grid size. Column counts rather than a fixed cover
 * width, so covers still fill the available space at every breakpoint. */
const GRID_CLASSES: Record<string, string> = {
  Small: 'grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-7 xl:grid-cols-8',
  Medium: 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6',
  Large: 'grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4',
};

const GAP_CLASSES: Record<string, string> = {
  Small: 'gap-x-3 gap-y-5',
  Medium: 'gap-x-5 gap-y-8',
  Large: 'gap-x-6 gap-y-10',
};

/**
 * Above this many covers, the grid reveals itself in chunks as you scroll instead of
 * mounting everything at once.
 *
 * Deliberately a threshold rather than always-on: only a library large enough for the
 * mount cost to be felt pays for the chunked reveal.
 */
const PROGRESSIVE_THRESHOLD = 120;

/** How many more to reveal each time the sentinel comes into view. */
const CHUNK = 60;

/**
 * The cover grid shared by the library, bookmarks, recents, and the Discover browsers,
 * so the grid-size preference applies everywhere covers are laid out.
 *
 * Note this bounds the *initial* render, not the total DOM: scroll far enough and every
 * card is still mounted. That is the deliberate trade — a true windowed grid would have to
 * measure the responsive column count and absolutely position its rows, which is a large
 * change to a component several screens depend on. Revisit if libraries reach several
 * thousand titles.
 */
export function MangaGrid({
  children,
  className = '',
  revealAtLeast = 0,
}: {
  children: ReactNode;
  className?: string;
  /** Mount at least this many covers straight away. A page restoring a scroll position
   * passes the number of cards the reader had already scrolled past, so the page is tall
   * enough to scroll back to where they were. */
  revealAtLeast?: number;
}) {
  const size = useSetting('gridSize', 'Medium') as string;
  const columns = GRID_CLASSES[size] ?? GRID_CLASSES.Medium;
  const gap = GAP_CLASSES[size] ?? GAP_CLASSES.Medium;

  const items = Children.toArray(children);
  const progressive = items.length > PROGRESSIVE_THRESHOLD;
  const [revealed, setRevealed] = useState(
    progressive ? Math.max(CHUNK, revealAtLeast) : items.length,
  );
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // A shorter list (a filter was applied, or a different shelf) must not keep showing a
  // count from the longer one it replaced. A *longer* list is an infinite-scroll append,
  // and collapsing it to the first chunk would shrink the page and yank the scroll position.
  const previousLength = useRef(items.length);
  useEffect(() => {
    const grew = items.length >= previousLength.current;
    previousLength.current = items.length;
    if (items.length <= PROGRESSIVE_THRESHOLD) setRevealed(items.length);
    else if (!grew) setRevealed(Math.max(CHUNK, revealAtLeast));
    else setRevealed((current) => Math.max(current, CHUNK, revealAtLeast));
  }, [items.length, revealAtLeast]);

  useEffect(() => {
    if (!progressive || revealed >= items.length) return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setRevealed((current) => Math.min(current + CHUNK, items.length));
        }
      },
      // Reveals the next chunk before the reader reaches the end, so the grid never
      // visibly runs out underneath them.
      { rootMargin: '600px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [progressive, revealed, items.length]);

  return (
    <>
      <div className={`grid ${columns} ${gap} ${className}`}>
        {progressive ? items.slice(0, revealed) : items}
      </div>
      {progressive && revealed < items.length && <div ref={sentinelRef} aria-hidden="true" />}
    </>
  );
}
