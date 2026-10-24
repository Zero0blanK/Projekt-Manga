'use client';

import { useEffect, useRef } from 'react';
import { TapZonesHint } from '@/components/reader/tap-zones-hint';
import { ChevronLeft, ChevronRight, ArrowRight, ArrowLeft } from 'lucide-react';
import { MangaPage } from '@/components/reader/manga-page';
import { useSetting } from '@/lib/app-store';
import { useScrollBehavior } from '@/lib/scroll';
import type { Manga } from '@/lib/manga-data';

/**
 * Renders every page of the chapter up front (skeletons sized to the real page count, no
 * guessing) in a horizontally snap-scrolling strip, and reports the current page from
 * what's actually visible via IntersectionObserver — not from button-click state. Moving
 * to another chapter is always an explicit action (the end/start panel, or the chapter
 * list) rather than an automatic side effect of page-position math.
 */
export function PagedViewer({
  manga,
  totalPages,
  pageUrls,
  pagesPerView,
  page,
  onPositionChange,
  hasNextChapter,
  nextChapterNumber,
  onRequestNextChapter,
  hasPrevChapter,
  prevChapterNumber,
  onRequestPrevChapter,
  zoom = 1,
  offsetFirstPage = false,
  readingDirection = 'Right to left',
  onPageReady,
  tapActions,
  onToggleControls,
  completionActions,
  fitOverride,
  onVisiblePage,
  autoAdvanceSecondsLeft = null,
  onCancelAutoAdvance,
}: {
  manga: Manga;
  totalPages: number;
  pageUrls: string[];
  pagesPerView: 1 | 2;
  /** Page to scroll to — read on mount and whenever it changes from *outside* this
   * component (resume link, chapter-list jump, progress-bar seek). Scrolling that
   * originates here instead reports back via onPositionChange, so the two never fight. */
  page: number;
  onPositionChange: (page: number) => void;
  hasNextChapter: boolean;
  nextChapterNumber: number;
  onRequestNextChapter: () => void;
  hasPrevChapter: boolean;
  prevChapterNumber: number;
  onRequestPrevChapter: () => void;
  zoom?: number;
  /** Settings > Reader > Offset first page — see `units` below. */
  offsetFirstPage?: boolean;
  readingDirection?: string;
  onPageReady?: (page: number) => void;
  tapActions?: { left: string; center: string; right: string };
  onToggleControls?: () => void;
  completionActions?: React.ReactNode;
  fitOverride?: string;
  onVisiblePage?: (page: number) => void;
  /** Seconds until the reader moves on by itself (Settings › Reader › auto-advance). */
  autoAdvanceSecondsLeft?: number | null;
  onCancelAutoAdvance?: () => void;
}) {
  const globalZoomBehavior = useSetting('zoomBehavior', 'Smart') as string;
  const zoomBehavior = fitOverride ?? globalZoomBehavior;
  const rtl = readingDirection === 'Right to left';
  const scrollBehavior = useScrollBehavior();

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const unitRefs = useRef<Array<HTMLDivElement | null>>([]);
  const nextPanelRef = useRef<HTMLDivElement | null>(null);
  const prevPanelRef = useRef<HTMLDivElement | null>(null);
  const readyPages = useRef(new Map<number, string>());
  const visibleUnit = useRef(0);
  // Tracks what we last scrolled to *and* how many units existed at the time — totalPages
  // corrects itself from a "1 page" fallback to the real count once chapter metadata
  // loads, which rebuilds `units` from under a stale scroll position even though `page`
  // itself didn't change, so page alone isn't enough to tell "already there" from "the
  // unit we're sitting on no longer means what it used to".
  const lastJump = useRef<{ page: number; totalPages: number } | null>(null);

  // Groups of pages shown together. In two-page mode "offset first page" puts page 1 on
  // its own so every later spread pairs the way the artist drew it (a cover counts as one
  // sheet, so without the offset every spread afterwards is split down the middle).
  const units: number[][] = [];
  let cursor = 1;
  if (pagesPerView === 2 && offsetFirstPage && totalPages >= 1) {
    units.push([1]);
    cursor = 2;
  }
  for (let p = cursor; p <= totalPages; p += pagesPerView) {
    const unit: number[] = [];
    for (let i = 0; i < pagesPerView && p + i <= totalPages; i++) unit.push(p + i);
    units.push(unit);
  }
  // The end-of-chapter panel is announced only while the final spread is showing.
  const atLastSpread = units.length === 0 || units[units.length - 1].includes(page);

  // Muted until the opening jump lands. The observer's first callback describes the
  // pre-scroll position, so without this a resume at page 9 would immediately be
  // reported back as page 1 and the jump undone.
  const pendingInitialJump = useRef(page > 1);

  // Jump to the requested page whenever it changes from outside (mount/resume, chapter-list
  // and progress-bar jumps). Skipped when it's just our own scroll position being reported
  // back up, so we don't fight the user's scroll.
  useEffect(() => {
    if (lastJump.current?.page === page && lastJump.current.totalPages === totalPages) return;
    const unitIndex = units.findIndex((u) => u.includes(page));
    const target = unitRefs.current[unitIndex === -1 ? 0 : unitIndex];
    if (target) {
      target.scrollIntoView({ block: 'nearest', inline: 'start' });
      lastJump.current = { page, totalPages };
      // Only stop muting once we've actually reached the requested page; while
      // totalPages is still the "1 page" placeholder the unit doesn't exist yet.
      if (unitIndex !== -1) {
        requestAnimationFrame(() => {
          pendingInitialJump.current = false;
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, manga.id, totalPages, offsetFirstPage]);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root || units.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const mostVisible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (!mostVisible) return;
        // See pendingInitialJump — don't report until the resume jump has landed.
        if (pendingInitialJump.current) return;
        const idx = Number((mostVisible.target as HTMLElement).dataset.unit);
        const unit = units[idx];
        visibleUnit.current = idx;
        if (unit) {
          lastJump.current = { page: unit[0], totalPages };
          onVisiblePage?.(unit[0]);
          if (
            unit.every(
              (p) => Boolean(pageUrls[p - 1]) && readyPages.current.get(p) === pageUrls[p - 1],
            )
          )
            onPositionChange(unit[unit.length - 1]);
        }
      },
      { root, threshold: [0.6] },
    );
    unitRefs.current.forEach((el) => el && observer.observe(el));
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [units.length, totalPages, pagesPerView, offsetFirstPage, pageUrls]);

  // Scroll to a specific child rather than by a pixel offset: `scrollBy` on a
  // `snap-mandatory` container gets overridden by the snap algorithm (Firefox in
  // particular simply reverts it).
  const scrollToEl = (el: HTMLElement | null) => {
    if (!el) return false;
    el.scrollIntoView({ behavior: scrollBehavior, block: 'nearest', inline: 'start' });
    return true;
  };

  const currentUnitIndex = Math.max(
    0,
    units.findIndex((u) => u.includes(page)),
  );

  // The strip's DOM order always runs 1..N regardless of reading direction (only the
  // left/right placement *within* a two-page spread flips for RTL) — so "advance"
  // unconditionally means the next unit, "retreat" the previous one. At either end it
  // lands on the adjacent chapter panel instead, which the reader then confirms.
  const advance = () => {
    if (currentUnitIndex < units.length - 1) scrollToEl(unitRefs.current[currentUnitIndex + 1]);
    else scrollToEl(nextPanelRef.current);
  };
  const retreat = () => {
    if (currentUnitIndex > 0) scrollToEl(unitRefs.current[currentUnitIndex - 1]);
    else scrollToEl(prevPanelRef.current);
  };

  // Physical on-screen buttons sit at fixed left/right edges, so which one advances vs.
  // retreats flips with reading direction to match the visual page layout.
  const leftAction = rtl ? advance : retreat;
  const rightAction = rtl ? retreat : advance;
  const pointer = useRef<{ x: number; y: number; id: number } | null>(null);
  const performTap = (action: string) => {
    if (action === 'Forward') advance();
    else if (action === 'Back') retreat();
    else if (action === 'Direction') {
      if (rtl) advance();
      else retreat();
    } else if (action === 'Opposite') {
      if (rtl) retreat();
      else advance();
    } else if (action === 'Controls') onToggleControls?.();
  };

  // See the keydown effect below: the listener is registered once, so it has to reach the
  // current handlers through a ref rather than closing over the ones it was created with.
  const navRef = useRef({ advance, retreat });
  navRef.current = { advance, retreat };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target instanceof Element ? e.target : null;
      if (
        document.querySelector('[role="dialog"]') ||
        el?.closest('input,textarea,select,button,a,[contenteditable="true"],[role="menu"]')
      )
        return;
      if (e.key === 'ArrowRight' || e.key === ' ') {
        e.preventDefault();
        navRef.current.advance();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        navRef.current.retreat();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // Subscribes once and stays subscribed; the handlers are read from navRef so they are
    // always current without re-binding a window listener on every render.
  }, []);

  const widthDriven =
    zoomBehavior === 'Fit width' || (zoomBehavior === 'Smart' && pagesPerView === 1);
  const fit: 'width' | 'height' | 'fixed' =
    zoomBehavior === 'Original' ? 'fixed' : widthDriven ? 'width' : 'height';
  const sizeClass =
    zoomBehavior === 'Original'
      ? 'h-[600px] w-[400px]'
      : widthDriven
        ? pagesPerView === 2
          ? 'w-[34vw] max-w-sm'
          : 'w-[60vw] max-w-xl'
        : 'h-[calc(85vh-3rem)]';

  return (
    <div className="relative flex flex-1 items-center justify-center overflow-hidden">
      {tapActions && <TapZonesHint tapActions={tapActions} rtl={rtl} />}
      <button
        onClick={leftAction}
        aria-label="Previous"
        className="absolute left-6 z-30 grid h-12 w-12 place-items-center rounded-full border border-white/10 bg-black/50 text-white/70 backdrop-blur transition hover:text-white"
      >
        <ChevronLeft className="h-5 w-5" />
      </button>

      <div
        ref={scrollRef}
        onPointerDown={(event) => {
          if (
            !tapActions ||
            zoom !== 1 ||
            !event.isPrimary ||
            event.button !== 0 ||
            (event.target as HTMLElement).closest('button,a,input,textarea,select,[role="dialog"]')
          ) {
            pointer.current = null;
            return;
          }
          pointer.current = { x: event.clientX, y: event.clientY, id: event.pointerId };
        }}
        onPointerCancel={() => {
          pointer.current = null;
        }}
        onPointerUp={(event) => {
          const start = pointer.current;
          pointer.current = null;
          if (
            !start ||
            start.id !== event.pointerId ||
            !tapActions ||
            Math.hypot(start.x - event.clientX, start.y - event.clientY) > 10 ||
            window.getSelection()?.toString() ||
            document.querySelector('[role="dialog"]')
          )
            return;
          const bounds = event.currentTarget.getBoundingClientRect();
          const fraction = (event.clientX - bounds.left) / bounds.width;
          performTap(
            fraction < 1 / 3
              ? tapActions.left
              : fraction > 2 / 3
                ? tapActions.right
                : tapActions.center,
          );
        }}
        className="flex h-full w-full snap-x snap-mandatory overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {hasPrevChapter && (
          <div
            ref={prevPanelRef}
            className="flex h-full w-full shrink-0 snap-start flex-col items-center justify-center gap-4 px-8 text-center text-white/70"
          >
            <p className="text-sm">Start of this chapter.</p>
            <button
              onClick={onRequestPrevChapter}
              className="flex items-center gap-2 rounded-full border border-white/20 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-white/10"
            >
              <ArrowLeft className="h-4 w-4" /> Back to Chapter {prevChapterNumber}
            </button>
          </div>
        )}

        {units.map((unit, i) => {
          const ordered = rtl ? [...unit].reverse() : unit;
          return (
            <div
              key={unit[0]}
              ref={(el) => {
                unitRefs.current[i] = el;
              }}
              data-unit={i}
              className="flex h-full w-full shrink-0 snap-start items-center justify-center gap-3"
              style={{ transform: `scale(${zoom})` }}
            >
              {ordered.map((p) => (
                <MangaPage
                  key={p}
                  manga={manga}
                  pageNumber={p}
                  totalPages={totalPages}
                  imageUrl={pageUrls[p - 1]}
                  className={sizeClass}
                  fit={fit}
                  onReady={() => {
                    readyPages.current.set(p, pageUrls[p - 1]);
                    onPageReady?.(p);
                    const visible = units[visibleUnit.current];
                    if (
                      !pendingInitialJump.current &&
                      visible?.includes(p) &&
                      visible.every(
                        (number) =>
                          Boolean(pageUrls[number - 1]) &&
                          readyPages.current.get(number) === pageUrls[number - 1],
                      )
                    )
                      onPositionChange(visible[visible.length - 1]);
                  }}
                />
              ))}
            </div>
          );
        })}

        {(hasNextChapter || completionActions) && (
          <div
            ref={nextPanelRef}
            // Present in the scroller from the start so it can be swiped to, but announced
            // only once the reader is on the last page.
            aria-hidden={!atLastSpread}
            inert={!atLastSpread}
            className="flex h-full w-full shrink-0 snap-start flex-col items-center justify-center gap-4 px-8 text-center text-white/70"
          >
            <p className="text-sm">You&apos;ve reached the end of this chapter.</p>
            {hasNextChapter && (
              <button
                onClick={onRequestNextChapter}
                className="flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground shadow-glow transition hover:opacity-90"
              >
                Continue to Chapter {nextChapterNumber} <ArrowRight className="h-4 w-4" />
              </button>
            )}
            {completionActions}
          </div>
        )}
      </div>

      {autoAdvanceSecondsLeft !== null && hasNextChapter && (
        <div
          role="status"
          className="absolute bottom-20 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-full border border-white/10 bg-black/80 py-1.5 pl-4 pr-1.5 text-sm text-white shadow-lg backdrop-blur"
        >
          <span className="tabular-nums">
            Chapter {nextChapterNumber} in {autoAdvanceSecondsLeft}s
          </span>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onCancelAutoAdvance?.();
            }}
            className="rounded-full bg-white/15 px-3 py-1 text-xs font-medium transition hover:bg-white/25"
          >
            Stay here
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onRequestNextChapter();
            }}
            className="rounded-full bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground"
          >
            Go now
          </button>
        </div>
      )}

      <button
        onClick={rightAction}
        aria-label="Next"
        className="absolute right-6 z-30 grid h-12 w-12 place-items-center rounded-full border border-white/10 bg-black/50 text-white/70 backdrop-blur transition hover:text-white"
      >
        <ChevronRight className="h-5 w-5" />
      </button>
    </div>
  );
}
