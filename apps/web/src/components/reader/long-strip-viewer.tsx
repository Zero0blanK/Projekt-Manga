import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MangaPage } from '@/components/reader/manga-page';
import type { Manga } from '@/lib/manga-data';

type ChapterPages = { status: 'loading' | 'loaded' | 'error'; urls: string[] };

/** Enough travel to count as a deliberate change of direction rather than jitter. */
const DIRECTION_THRESHOLD_PX = 24;

/**
 * How long after the app moves the strip itself to keep ignoring scroll events.
 *
 * A scroll event arrives a frame or more after `scrollTop` is assigned, so a flag cleared
 * synchronously would already be gone by the time the event it belongs to is dispatched.
 */
const PROGRAMMATIC_SCROLL_WINDOW_MS = 150;

/**
 * Seamless webtoon mode — pages butt edge-to-edge, and once the reader nears the bottom
 * of the current chapter, the next chapter's pages are appended automatically so reading
 * flows continuously across chapter boundaries instead of stopping at the last page.
 */
export function LongStripViewer({
  manga,
  ready,
  startChapter,
  startPage,
  getNextChapter,
  getChapterTitle,
  getChapterPageCount,
  fetchPages,
  onPositionChange,
  zoom = 1,
  pageGap = 0,
  autoAdvance = false,
  onPageReady,
  completionActions,
  getChapterIdentity,
  releaseVersion,
  onScrollDirection,
  scrollSpeed = 1,
  autoScrollPixelsPerSecond = 0,
}: {
  manga: Manga;
  /** Chapter metadata has loaded. Fetching pages before this resolves nothing (the
   * chapter-number → record lookup is still empty), so everything waits on it. */
  ready: boolean;
  startChapter: number;
  /** Page to open at within `startChapter` — resuming saved progress, or a chapter-list
   * link for a partly-read chapter. Applied once that chapter's pages exist. */
  startPage: number;
  /** Real next chapter number, or null at the end — chapter numbers aren't contiguous
   * integers (10.3, 11.1, 11.2 …), so the next one can't be derived by adding 1. */
  getNextChapter: (chapter: number) => number | null;
  getChapterTitle: (chapter: number) => string;
  /** Known page count, for sizing the skeleton list before pages arrive (0 when the
   * source doesn't report one). */
  getChapterPageCount: (chapter: number) => number;
  fetchPages: (chapter: number) => Promise<string[]>;
  /** Reports the visible position plus that chapter's real page total (0 while unknown) —
   * this viewer fetches its own pages, so it's the only place the total is known. */
  onPositionChange: (chapter: number, page: number, total: number) => void;
  zoom?: number;
  /** Settings > Reader > Page gap — 0 keeps pages butted edge-to-edge. */
  pageGap?: number;
  autoAdvance?: boolean;
  onPageReady?: (chapter: number, page: number) => void;
  completionActions?: React.ReactNode;
  getChapterIdentity?: (chapter: number) => string;
  releaseVersion?: string | null;
  /** Fired when the reader changes scrolling direction, so the chrome can get out of the
   * way on the way down and come back on the way up. Debounced by DIRECTION_THRESHOLD_PX
   * rather than fired per event — a trackpad emits a stream of sub-pixel deltas, and
   * reacting to each one makes the header flicker. */
  onScrollDirection?: (direction: 'up' | 'down') => void;
  /** Multiplier on one wheel notch. 1 leaves the wheel alone entirely. */
  scrollSpeed?: number;
  /** Hands-free scrolling rate; 0 means not running. */
  autoScrollPixelsPerSecond?: number;
}) {
  const [loadedChapters, setLoadedChapters] = useState<number[]>([startChapter]);
  const [pagesByChapter, setPagesByChapter] = useState<Record<number, ChapterPages>>({});
  const [retryToken, setRetryToken] = useState(0);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const pageEls = useRef(new Map<string, HTMLDivElement>());
  /** Scroll events before this timestamp were caused by this component, not the reader. */
  const programmaticUntil = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const prevZoomRef = useRef(zoom);
  const fetchedIdentities = useRef(new Map<number, string>());
  const identityRef = useRef(getChapterIdentity);
  identityRef.current = getChapterIdentity;

  useEffect(() => {
    if (!ready) return;
    for (const chapterNum of loadedChapters) {
      // Only skip chapters already resolved or in flight — an entry must never be
      // recorded before its fetch settles, or a chapter that resolved empty (e.g. it was
      // requested before metadata arrived) would be cached as "done" and never retried.
      const identity = getChapterIdentity?.(chapterNum) ?? String(chapterNum);
      if (pagesByChapter[chapterNum] && fetchedIdentities.current.get(chapterNum) === identity)
        continue;
      fetchedIdentities.current.set(chapterNum, identity);
      setPagesByChapter((prev) => ({ ...prev, [chapterNum]: { status: 'loading', urls: [] } }));
      fetchPages(chapterNum)
        .then((urls) => {
          if ((identityRef.current?.(chapterNum) ?? String(chapterNum)) !== identity) return;
          setPagesByChapter((prev) => ({
            ...prev,
            [chapterNum]: { status: urls.length > 0 ? 'loaded' : 'error', urls },
          }));
        })
        .catch(() => {
          if ((identityRef.current?.(chapterNum) ?? String(chapterNum)) !== identity) return;
          setPagesByChapter((prev) => ({
            ...prev,
            [chapterNum]: { status: 'error', urls: [] },
          }));
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedChapters, ready, retryToken, releaseVersion]);

  // Column width scales with zoom, which reflows the whole strip — rescale scrollTop by
  // the same factor so whatever the reader was looking at stays in view instead of jumping.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const prevZoom = prevZoomRef.current;
    if (el && prevZoom !== zoom) {
      // Not the reader scrolling — pressing the zoom button in the header would otherwise
      // read as a scroll down and hide the very control that was just clicked.
      programmaticUntil.current = performance.now() + PROGRAMMATIC_SCROLL_WINDOW_MS;
      el.scrollTop = (el.scrollTop * zoom) / prevZoom;
    }
    prevZoomRef.current = zoom;
  }, [zoom]);

  // Only reset the stream when the chapter changes to one we haven't already streamed into
  // (an explicit jump via the chapter list/link) — not when our own scroll-driven URL sync
  // fires for a chapter we already appended.
  useEffect(() => {
    setLoadedChapters((prev) => (prev.includes(startChapter) ? prev : [startChapter]));
  }, [manga.id, startChapter]);

  // Jump to the requested page once that chapter's pages are actually on screen. The
  // element can't be scrolled to before it exists, so this waits for the fetch rather
  // than firing on mount.
  const jumpedTo = useRef<string | null>(null);
  // Until the opening jump has happened, position reporting is suppressed. The strip
  // renders skeletons immediately, so the visibility observer would otherwise report
  // "page 1" while the pages are still loading, and the parent would overwrite the very
  // page we were asked to resume at — losing the jump before it could run.
  const pendingInitialJump = useRef(startPage > 1);

  useEffect(() => {
    const target = `${startChapter}:${startPage}`;
    if (jumpedTo.current === target) return;
    if ((pagesByChapter[startChapter]?.urls.length ?? 0) < startPage) {
      // Give up waiting if the chapter failed to load, otherwise reporting stays muted.
      if (pagesByChapter[startChapter]?.status === 'error') pendingInitialJump.current = false;
      return;
    }
    const el = pageEls.current.get(target);
    if (!el) return;
    jumpedTo.current = target;
    // `startPage` also follows the reader's own scrolling, so only actually move when the
    // target isn't already on screen — otherwise every scroll would re-snap the view.
    const rect = el.getBoundingClientRect();
    const alreadyInView = rect.bottom > 0 && rect.top < window.innerHeight;
    if (!alreadyInView) el.scrollIntoView({ block: 'start' });
    // Released on the next frame: scrollIntoView settles asynchronously, and reporting
    // the pre-scroll position would immediately undo the jump.
    requestAnimationFrame(() => {
      pendingInitialJump.current = false;
    });
  }, [startChapter, startPage, pagesByChapter]);

  // Auto-append the next chapter once the reader scrolls near the bottom — but only after
  // the last loaded chapter actually has pages on screen. Otherwise an empty strip leaves
  // the sentinel permanently in view, which chain-appends chapter after chapter on top of
  // one that never rendered (and drags the URL along with it).
  const lastLoaded = loadedChapters[loadedChapters.length - 1];
  const lastChapterHasPages = (pagesByChapter[lastLoaded]?.urls.length ?? 0) > 0;

  useEffect(() => {
    if (!ready || !lastChapterHasPages || !autoAdvance) return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0].isIntersecting) return;
        setLoadedChapters((prev) => {
          const next = getNextChapter(prev[prev.length - 1]);
          if (next === null || prev.includes(next)) return prev;
          return [...prev, next];
        });
      },
      { rootMargin: '800px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, lastChapterHasPages, loadedChapters.length, autoAdvance]);

  /**
   * The position observer is created only when the loaded set changes, so it must reach
   * the *current* handler through a ref rather than closing over the one it was built
   * with. `onPositionChange` is recreated every render and compares against the parent's
   * `chapter` state; a captured copy would compare against a stale chapter, so scrolling
   * back into an already-loaded chapter would not update the chapter or the URL, and the
   * auto-mark-read effect could mark the wrong chapter.
   */
  const onPositionChangeRef = useRef(onPositionChange);
  onPositionChangeRef.current = onPositionChange;

  // Track which chapter+page is actually in view to drive progress and the URL.
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const mostVisible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (!mostVisible) return;
        // Don't report position until the opening jump has run — see pendingInitialJump.
        if (pendingInitialJump.current) return;
        const key = (mostVisible.target as HTMLElement).dataset.key;
        if (!key) return;
        const [chapterStr, pageStr] = key.split(':');
        const visibleChapter = Number(chapterStr);
        onPositionChangeRef.current(
          visibleChapter,
          Number(pageStr),
          pagesByChapter[visibleChapter]?.urls.length ?? 0,
        );
      },
      { threshold: [0.5] },
    );
    pageEls.current.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [loadedChapters, pagesByChapter]);

  // Report direction changes for the chrome auto-hide.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !onScrollDirection) return;
    let last = el.scrollTop;
    let reported: 'up' | 'down' | null = null;
    const onScroll = () => {
      const top = el.scrollTop;
      // Zoom rescaling and auto-scroll both move the strip without the reader touching it.
      // Resync the baseline so the next real scroll is measured from where we actually are.
      if (performance.now() < programmaticUntil.current) {
        last = top;
        return;
      }
      const delta = top - last;
      if (Math.abs(delta) < DIRECTION_THRESHOLD_PX) return;
      last = top;
      // Never hide at the very top: there is nothing above to scroll back to, so a user
      // who lands there and nudges downward would be left with no way to reach the
      // controls except scrolling back up again.
      const direction = delta > 0 && top > DIRECTION_THRESHOLD_PX ? 'down' : 'up';
      if (direction === reported) return;
      reported = direction;
      onScrollDirection(direction);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [onScrollDirection]);

  useEffect(() => {
    const el = scrollRef.current;
    // Exactly 1 deliberately attaches nothing: intercepting the wheel replaces the
    // browser's own smooth/momentum scrolling with discrete jumps, which is a real
    // downgrade to pay for a setting the reader left at its default.
    if (!el || scrollSpeed === 1) return;
    const onWheel = (event: WheelEvent) => {
      // Pinch-zoom and horizontal gestures are not ours to rescale.
      if (event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      // deltaMode 1 is lines, 2 is pages — normalise so a mouse that reports lines is
      // scaled by the same factor as one that reports pixels.
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? el.clientHeight : 1;
      event.preventDefault();
      el.scrollTop += event.deltaY * unit * scrollSpeed;
    };
    // Not passive: the whole point is to replace the default scroll distance.
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [scrollSpeed]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || autoScrollPixelsPerSecond <= 0) return;
    let frame = 0;
    let previous: number | null = null;
    // Sub-pixel remainder carried between frames: at 24px/s a 60Hz frame moves 0.4px, and
    // scrollTop quantises to whole pixels, so dropping the remainder would stall entirely
    // at the slowest speeds.
    let carry = 0;
    const step = (now: number) => {
      if (previous !== null) {
        // Clamped so a backgrounded tab's long gap does not jump the reader down the page
        // all at once when it returns.
        const seconds = Math.min(0.25, (now - previous) / 1000);
        carry += autoScrollPixelsPerSecond * seconds;
        const whole = Math.floor(carry);
        if (whole > 0) {
          carry -= whole;
          const before = el.scrollTop;
          // Hands-free scrolling is the app moving the page, not the reader, so it must
          // not take the controls away — least of all while they are being used to change
          // its speed.
          programmaticUntil.current = performance.now() + PROGRAMMATIC_SCROLL_WINDOW_MS;
          el.scrollTop = before + whole;
          // Bottom reached and nothing more appended yet — stop pushing against the end.
          if (el.scrollTop === before) carry = 0;
        }
      }
      previous = now;
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [autoScrollPixelsPerSecond]);

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto">
      <div className="mx-auto flex flex-col" style={{ maxWidth: `${36 * zoom}rem` }}>
        {loadedChapters.map((chapterNum) => {
          const entry = pagesByChapter[chapterNum];
          const pages = entry?.urls ?? [];
          // Before pages arrive, show one skeleton per real page when the source reports a
          // count, so the strip has its true length instead of collapsing to a single box.
          const skeletonCount = getChapterPageCount(chapterNum) || 3;
          const pageCount = pages.length || skeletonCount;
          return (
            <div key={chapterNum}>
              <div className="py-3 text-center text-[11px] uppercase tracking-[0.2em] text-white/60">
                Chapter {chapterNum} · {getChapterTitle(chapterNum)}
              </div>
              {entry?.status === 'error' && pages.length === 0 ? (
                <div className="px-6 py-12 text-center text-sm text-white/50">
                  Couldn&apos;t load this chapter&apos;s pages.
                  <button
                    type="button"
                    className="ml-2 text-primary hover:underline"
                    onClick={() => {
                      setPagesByChapter((prev) => {
                        const next = { ...prev };
                        delete next[chapterNum];
                        return next;
                      });
                      setRetryToken((value) => value + 1);
                    }}
                  >
                    Try again
                  </button>
                </div>
              ) : (
                Array.from({ length: pageCount }, (_, i) => i + 1).map((p) => {
                  const key = `${chapterNum}:${p}`;
                  return (
                    <div
                      key={`${getChapterIdentity?.(chapterNum) ?? chapterNum}:${p}`}
                      ref={(el) => {
                        if (el) pageEls.current.set(key, el);
                        else pageEls.current.delete(key);
                      }}
                      data-key={key}
                      style={pageGap > 0 && p > 1 ? { marginTop: pageGap } : undefined}
                    >
                      <MangaPage
                        manga={manga}
                        pageNumber={p}
                        totalPages={pageCount}
                        imageUrl={pages[p - 1]}
                        className="w-full"
                        fit="width"
                        seamless={pageGap === 0}
                        onReady={() => onPageReady?.(chapterNum, p)}
                      />
                    </div>
                  );
                })
              )}
            </div>
          );
        })}
        <div ref={sentinelRef} className="h-1" />
        {completionActions && (
          <div className="flex flex-wrap justify-center gap-3 p-6 text-white">
            {completionActions}
          </div>
        )}
      </div>
    </div>
  );
}
