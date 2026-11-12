'use client';

import { useEffect, useRef } from 'react';

/**
 * When nearing the end of the current chapter, warms the next chapters' first pages so
 * stepping across the boundary doesn't stall on a fresh chapter-pages fetch. Waits for the
 * *current* chapter's own real pages to be loaded (not just the metadata page_count,
 * which some sources — e.g. MangaGeko — never populate, leaving it 0) so this never fires
 * a next-chapter scrape concurrently with the current chapter's own still-in-flight one.
 */
export function useNextChapterPreload({
  enabled,
  chapter,
  page,
  pageUrls,
  pagePrefetchAhead,
  chapterPrefetchCount,
  nextChapterAfter,
  fetchPages,
}: {
  /** Settings > Reader > Preload next chapter, in a layout that pages. */
  enabled: boolean;
  chapter: number;
  page: number;
  /** The current chapter's loaded pages; empty while still loading. */
  pageUrls: readonly string[];
  pagePrefetchAhead: number;
  /** Settings > Reader > Chapters to preload. */
  chapterPrefetchCount: number;
  nextChapterAfter: (chapter: number) => number | null;
  /** A chapter's page list. Must answer a list already loading or loaded without asking
   * the source again: this runs on every page turn near the boundary. */
  fetchPages: (chapter: number) => Promise<string[]>;
}): void {
  const nextChapterRef = useRef(nextChapterAfter);
  nextChapterRef.current = nextChapterAfter;
  const fetchPagesRef = useRef(fetchPages);
  fetchPagesRef.current = fetchPages;
  useEffect(() => {
    if (!enabled) return;
    if (pageUrls.length === 0) return;
    // The trigger distance follows the page-prefetch window, so raising one doesn't leave
    // the other reaching across the chapter boundary too late to help.
    const trigger = Math.max(1, pagePrefetchAhead);
    if (pageUrls.length - page > trigger) return;

    // Settings > Reader > Chapters to preload: walk that many chapters forward.
    const upcoming: number[] = [];
    let cursor = chapter;
    for (let i = 0; i < chapterPrefetchCount; i++) {
      const next = nextChapterRef.current(cursor);
      if (next === null) break;
      upcoming.push(next);
      cursor = next;
    }
    if (upcoming.length === 0) return;

    let cancelled = false;
    // Sequential, not parallel: several concurrent chapter scrapes against one source is
    // exactly the traffic pattern that gets a scraper rate-limited. This re-runs on every
    // page turn near the boundary, which fetchPages makes free: a list that's already
    // loading or loaded isn't asked for twice.
    void (async () => {
      for (const target of upcoming) {
        if (cancelled) return;
        try {
          const urls = await fetchPagesRef.current(target);
          if (cancelled || urls.length === 0) return;
          const img = new window.Image();
          img.src = urls[0];
        } catch {
          return;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, chapterPrefetchCount, pagePrefetchAhead, chapter, page, pageUrls]);
}
