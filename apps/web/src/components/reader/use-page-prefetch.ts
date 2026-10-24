import { useEffect, useRef } from 'react';

/**
 * Preloads page images the reader is about to need — the current page plus a forward
 * window — so paging ahead feels instant. Deliberately forward-only: jumping to page 8
 * of 24 loads page 8 first and warms 9–12, but never eagerly fetches 1–7. Stepping back
 * to 7 loads it on demand (it becomes the new "current page" and the window follows).
 */
export function usePagePrefetch(pageUrls: string[], currentPage: number, ahead = 4) {
  const cache = useRef(new Set<string>());

  useEffect(() => {
    cache.current.clear();
  }, [pageUrls]);

  useEffect(() => {
    const start = Math.max(1, currentPage);
    const end = Math.min(pageUrls.length, currentPage + ahead);
    for (let p = start; p <= end; p++) {
      const url = pageUrls[p - 1];
      if (!url || cache.current.has(url)) continue;
      cache.current.add(url);
      const img = new window.Image();
      img.src = url;
    }
  }, [pageUrls, currentPage, ahead]);
}
