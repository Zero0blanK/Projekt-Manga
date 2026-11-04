'use client';

import { useEffect, useRef, useState } from 'react';
import { TapZonesHint } from '@/components/reader/tap-zones-hint';
import { ChevronLeft, ChevronRight, ArrowRight, ArrowLeft } from 'lucide-react';
import { MangaPage } from '@/components/reader/manga-page';
import { useSetting } from '@/lib/app-store';
import {
  READER_ROTATE_WIDE,
  READER_SPLIT_WIDE,
  READER_SWAP_SPREAD,
  buildReaderUnits,
  isTallPage,
  isWidePage,
} from '@/lib/page-image';
import { useScrollBehavior } from '@/lib/scroll';
import { READER_ZONE_LAYOUT, zoneAt } from '@/lib/click-zones';
import {
  DOUBLE_CLICK_WINDOW_MS,
  READER_DOUBLE_CLICK_ZOOM,
  READER_WHEEL_ACTION,
} from '@/lib/reader-keys';
import { DOUBLE_CLICK_ZOOM, ZOOM_STEP, clampZoom } from '@/lib/reader-zoom';
import { useReaderInput } from '@/components/reader/use-reader-input';
import { READER_GUIDED_VIEW } from '@/lib/panel-detect';
import type { ViewRect } from '@/lib/page-image';
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
  onZoomChange,
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
  onLooksLikeWebtoon,
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
  /** Lets the wheel and double-click zoom. Without it they leave zoom alone. */
  onZoomChange?: (zoom: number) => void;
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
  /** Called once when most of the first pages are far taller than wide: a webtoon being
   * read page by page, better read in the long strip. */
  onLooksLikeWebtoon?: () => void;
}) {
  const globalZoomBehavior = useSetting('zoomBehavior', 'Smart') as string;
  const zoomBehavior = fitOverride ?? globalZoomBehavior;
  const rtl = readingDirection === 'Right to left';
  const scrollBehavior = useScrollBehavior();
  const zoneLayout = useSetting(READER_ZONE_LAYOUT, 'Thirds') as string;
  const wheelAction = useSetting(READER_WHEEL_ACTION, 'Turn page') as string;
  const doubleClickZoom = (useSetting(READER_DOUBLE_CLICK_ZOOM, true) as boolean) && !!onZoomChange;
  // Where a zoom is anchored (the cursor, for double-click and Ctrl+wheel) and how far
  // the zoomed page has been dragged; both go back to the centre once zoom is reset.
  const [zoomOrigin, setZoomOrigin] = useState<{ x: number; y: number } | null>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  useEffect(() => {
    if (zoom !== 1) return;
    setZoomOrigin(null);
    setPan({ x: 0, y: 0 });
  }, [zoom]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const unitRefs = useRef<Array<HTMLDivElement | null>>([]);
  const nextPanelRef = useRef<HTMLDivElement | null>(null);
  const prevPanelRef = useRef<HTMLDivElement | null>(null);
  const readyPages = useRef(new Map<number, string>());
  const visibleUnit = useRef(0);
  // The half of a split page last seen on screen. Indices shift when another page turns
  // out to be a double page, so the jump below finds the same half by page and side.
  const visibleHalf = useRef<{ page: number; half?: 'left' | 'right' } | null>(null);
  // Tracks what we last scrolled to *and* how many units existed at the time — totalPages
  // corrects itself from a "1 page" fallback to the real count once chapter metadata
  // loads, which rebuilds `units` from under a stale scroll position even though `page`
  // itself didn't change, so page alone isn't enough to tell "already there" from "the
  // unit we're sitting on no longer means what it used to".
  const lastJump = useRef<{ page: number; totalPages: number; unitCount: number } | null>(null);
  const splitWide = useSetting(READER_SPLIT_WIDE, false) as boolean;
  const rotateWide = useSetting(READER_ROTATE_WIDE, false) as boolean;
  const swapSpread = useSetting(READER_SWAP_SPREAD, false) as boolean;
  // Guided view: one panel at a time, single-page mode only. Panels are found per page as
  // it loads; a page without them is shown whole.
  const guided = (useSetting(READER_GUIDED_VIEW, false) as boolean) && pagesPerView === 1;
  const [panels, setPanels] = useState<ReadonlyMap<number, ViewRect[]>>(() => new Map());
  const [panelStep, setPanelStep] = useState({ page: 0, index: 0 });
  // Page shapes seen so far, for spotting a webtoon read page by page.
  const shapes = useRef({ tall: 0, seen: 0, reported: false });
  // Image URLs found to be double pages once they loaded. Kept by URL so another
  // chapter's pages never inherit this one's.
  const [wideUrls, setWideUrls] = useState<ReadonlySet<string>>(() => new Set());
  const widePages = new Set<number>();
  pageUrls.forEach((url, i) => url && wideUrls.has(url) && widePages.add(i + 1));

  // Groups of pages shown together (see buildReaderUnits): spreads in two-page mode, and
  // the halves of a split double page. `units` holds just the source page numbers, which
  // is all that position reporting needs.
  const readerUnits = buildReaderUnits({
    totalPages,
    pagesPerView,
    offsetFirstPage,
    widePages,
    splitWide,
    rotateWide,
    rtl,
  });
  const units = readerUnits.map((unit) => unit.pages);
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
    if (
      lastJump.current?.page === page &&
      lastJump.current.totalPages === totalPages &&
      lastJump.current.unitCount === units.length
    )
      return;
    const sameHalf = visibleHalf.current?.page === page ? visibleHalf.current.half : undefined;
    const unitIndex = readerUnits.findIndex(
      (u) => u.pages.includes(page) && (sameHalf === undefined || u.half === sameHalf),
    );
    const target = unitRefs.current[unitIndex === -1 ? 0 : unitIndex];
    if (target) {
      target.scrollIntoView({ block: 'nearest', inline: 'start' });
      lastJump.current = { page, totalPages, unitCount: units.length };
      // Only stop muting once we've actually reached the requested page; while
      // totalPages is still the "1 page" placeholder the unit doesn't exist yet.
      if (unitIndex !== -1) {
        requestAnimationFrame(() => {
          pendingInitialJump.current = false;
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, manga.id, totalPages, offsetFirstPage, units.length]);

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
          visibleHalf.current = { page: unit[0], half: readerUnits[idx]?.half };
          lastJump.current = { page: unit[0], totalPages, unitCount: units.length };
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

  // The visible unit when it shows the current page: both halves of a split page carry
  // the same page number, so searching by page alone would always find the first half.
  const currentUnitIndex = units[visibleUnit.current]?.includes(page)
    ? visibleUnit.current
    : Math.max(
        0,
        units.findIndex((u) => u.includes(page)),
      );

  // The strip's DOM order always runs 1..N regardless of reading direction (only the
  // left/right placement *within* a two-page spread flips for RTL) — so "advance"
  // unconditionally means the next unit, "retreat" the previous one. At either end it
  // lands on the adjacent chapter panel instead, which the reader then confirms.
  const currentPage = units[currentUnitIndex]?.[0] ?? 0;
  // A split half or a page turned on its side is shown as it is, not panel by panel.
  const wholeUnit = (unit: (typeof readerUnits)[number] | undefined) =>
    !!unit && !unit.half && !unit.rotate;
  const pagePanels =
    guided && wholeUnit(readerUnits[currentUnitIndex]) ? (panels.get(currentPage) ?? []) : [];
  const panelIndex = panelStep.page === currentPage ? panelStep.index : 0;
  const advance = () => {
    if (panelIndex < pagePanels.length - 1) {
      setPanelStep({ page: currentPage, index: panelIndex + 1 });
      return;
    }
    if (currentUnitIndex < units.length - 1) {
      setPanelStep({ page: units[currentUnitIndex + 1][0], index: 0 });
      scrollToEl(unitRefs.current[currentUnitIndex + 1]);
    } else scrollToEl(nextPanelRef.current);
  };
  const retreat = () => {
    if (guided && panelIndex > 0) {
      setPanelStep({ page: currentPage, index: panelIndex - 1 });
      return;
    }
    if (currentUnitIndex > 0) {
      // Back onto the previous page's last panel, the way it was left.
      const previous = units[currentUnitIndex - 1][0];
      const previousPanels = wholeUnit(readerUnits[currentUnitIndex - 1])
        ? (panels.get(previous)?.length ?? 1)
        : 1;
      setPanelStep({ page: previous, index: Math.max(0, previousPanels - 1) });
      scrollToEl(unitRefs.current[currentUnitIndex - 1]);
    } else scrollToEl(prevPanelRef.current);
  };
  const focusFor = (p: number) => {
    if (!guided) return null;
    const list = panels.get(p) ?? [];
    return list[panelStep.page === p ? panelStep.index : 0] ?? null;
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

  // The window listeners below are registered once, so they reach the current handlers
  // through refs rather than closing over the ones they were created with.
  const navRef = useRef({ advance, retreat });
  navRef.current = { advance, retreat };
  const performTapRef = useRef(performTap);
  performTapRef.current = performTap;
  const zoomRef = useRef({ zoom, onZoomChange, wheelAction });
  zoomRef.current = { zoom, onZoomChange, wheelAction };

  useReaderInput({
    nextPage: () => navRef.current.advance(),
    prevPage: () => navRef.current.retreat(),
    firstPage: () => {
      scrollToEl(unitRefs.current[0]);
    },
    lastPage: () => {
      scrollToEl(unitRefs.current[units.length - 1]);
    },
  });

  /** The point under the cursor in the coordinates of the unit it is over, which is what
   * `transform-origin` is measured in. */
  const anchorAt = (target: EventTarget | null, clientX: number, clientY: number) => {
    const unit =
      (target instanceof Element && target.closest<HTMLElement>('[data-unit]')) ||
      scrollRef.current;
    const box = unit?.getBoundingClientRect();
    return box ? { x: clientX - box.left, y: clientY - box.top } : null;
  };

  // Settings › Reader › Mouse wheel. Registered by hand: React's onWheel is passive, and
  // turning the page needs preventDefault to stop the strip scrolling at the same time.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let lastEvent = 0;
    let lastTurn = 0;
    const onWheel = (event: WheelEvent) => {
      const { zoom: current, onZoomChange: setZoom, wheelAction: mode } = zoomRef.current;
      // A sideways trackpad swipe scrolls the strip natively.
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      if (event.ctrlKey || mode === 'Zoom') {
        if (!setZoom) return;
        event.preventDefault();
        if (current === 1) setZoomOrigin(anchorAt(event.target, event.clientX, event.clientY));
        setZoom(clampZoom(current + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP)));
        return;
      }
      if (mode !== 'Turn page' || current !== 1) return;
      event.preventDefault();
      // One page per wheel gesture: a trackpad fling or a fast spin fires dozens of
      // events, so only the first of a burst turns the page.
      const now = performance.now();
      const burst = now - lastEvent < 150 && now - lastTurn < 600;
      lastEvent = now;
      if (burst || Math.abs(event.deltaY) < 4) return;
      lastTurn = now;
      if (event.deltaY > 0) navRef.current.advance();
      else navRef.current.retreat();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Double-click: a click waits this long for a second one before acting as a tap.
  const lastClick = useRef<{ x: number; y: number; at: number } | null>(null);
  const pendingTap = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (pendingTap.current) clearTimeout(pendingTap.current);
    },
    [],
  );
  const panStart = useRef<{ x: number; y: number; panX: number; panY: number; id: number } | null>(
    null,
  );

  const widthDriven =
    zoomBehavior === 'Fit width' || (zoomBehavior === 'Smart' && pagesPerView === 1);
  const fit: 'width' | 'height' | 'fixed' =
    zoomBehavior === 'Original' ? 'fixed' : widthDriven ? 'width' : 'height';
  const sizeClass =
    zoomBehavior === 'Original'
      ? 'aspect-[2/3] w-[400px] max-w-[calc(100vw-1rem)]'
      : widthDriven
        ? pagesPerView === 2
          ? 'w-[48vw] max-w-sm sm:w-[34vw]'
          : 'w-[calc(100vw-1rem)] max-w-xl sm:w-[60vw]'
        : 'h-[calc(85vh-3rem)]';

  return (
    <div className="relative flex flex-1 items-center justify-center overflow-hidden">
      {tapActions && <TapZonesHint tapActions={tapActions} rtl={rtl} layout={zoneLayout} />}
      {pagePanels.length > 0 && (
        <span
          role="status"
          className="pointer-events-none absolute left-1/2 top-4 z-30 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1 text-xs text-white/80"
        >
          Panel {panelIndex + 1} of {pagePanels.length}
        </span>
      )}
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
          panStart.current = null;
          if (
            (!tapActions && !doubleClickZoom && zoom === 1) ||
            !event.isPrimary ||
            event.button !== 0 ||
            (event.target as HTMLElement).closest('button,a,input,textarea,select,[role="dialog"]')
          ) {
            pointer.current = null;
            return;
          }
          pointer.current = { x: event.clientX, y: event.clientY, id: event.pointerId };
          // A zoomed page is dragged around instead of tapped.
          if (zoom !== 1) {
            panStart.current = { ...pointer.current, panX: pan.x, panY: pan.y };
            event.currentTarget.setPointerCapture?.(event.pointerId);
          }
        }}
        onPointerMove={(event) => {
          const start = panStart.current;
          if (!start || start.id !== event.pointerId) return;
          setPan({
            x: start.panX + event.clientX - start.x,
            y: start.panY + event.clientY - start.y,
          });
        }}
        onPointerCancel={() => {
          pointer.current = null;
          panStart.current = null;
        }}
        onPointerUp={(event) => {
          const start = pointer.current;
          pointer.current = null;
          panStart.current = null;
          if (
            !start ||
            start.id !== event.pointerId ||
            Math.hypot(start.x - event.clientX, start.y - event.clientY) > 10 ||
            window.getSelection()?.toString() ||
            document.querySelector('[role="dialog"]')
          )
            return;
          if (doubleClickZoom && onZoomChange) {
            const now = performance.now();
            const previous = lastClick.current;
            if (
              previous &&
              now - previous.at < DOUBLE_CLICK_WINDOW_MS &&
              Math.hypot(previous.x - event.clientX, previous.y - event.clientY) < 24
            ) {
              lastClick.current = null;
              if (pendingTap.current) clearTimeout(pendingTap.current);
              pendingTap.current = null;
              if (zoom === 1) {
                setZoomOrigin(anchorAt(event.target, event.clientX, event.clientY));
                onZoomChange(DOUBLE_CLICK_ZOOM);
              } else onZoomChange(1);
              return;
            }
            lastClick.current = { x: event.clientX, y: event.clientY, at: now };
          }
          if (!tapActions || zoom !== 1) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          const zone = zoneAt(
            (event.clientX - bounds.left) / bounds.width,
            (event.clientY - bounds.top) / bounds.height,
            zoneLayout,
          );
          if (!zone) return;
          const action = tapActions[zone];
          if (!doubleClickZoom) return performTap(action);
          if (pendingTap.current) clearTimeout(pendingTap.current);
          pendingTap.current = setTimeout(() => {
            pendingTap.current = null;
            performTapRef.current(action);
          }, DOUBLE_CLICK_WINDOW_MS);
        }}
        className={`flex h-full w-full snap-x snap-mandatory overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${zoom !== 1 ? 'cursor-grab active:cursor-grabbing' : ''}`}
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
          // Right to left puts the first page of a spread on the right; "swap" flips that
          // for releases whose pages were paired the other way round.
          const ordered = rtl !== swapSpread ? [...unit].reverse() : unit;
          const { half, rotate } = readerUnits[i];
          return (
            <div
              key={`${unit[0]}:${half ?? ''}`}
              ref={(el) => {
                unitRefs.current[i] = el;
              }}
              data-unit={i}
              className="flex h-full w-full shrink-0 snap-start items-center justify-center gap-3"
              style={{
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                transformOrigin: zoomOrigin ? `${zoomOrigin.x}px ${zoomOrigin.y}px` : undefined,
              }}
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
                  half={half}
                  rotate={rotate}
                  focus={half || rotate ? null : focusFor(p)}
                  panelsRtl={rtl}
                  onPanels={
                    guided && !half && !rotate
                      ? (found) => setPanels((current) => new Map(current).set(p, found))
                      : undefined
                  }
                  onNaturalSize={(width, height) => {
                    const seen = shapes.current;
                    seen.seen += 1;
                    if (isTallPage(width, height)) seen.tall += 1;
                    if (!seen.reported && seen.seen >= 3 && seen.tall / seen.seen >= 2 / 3) {
                      seen.reported = true;
                      onLooksLikeWebtoon?.();
                    }
                    const url = pageUrls[p - 1];
                    if (url && isWidePage(width, height) && !wideUrls.has(url))
                      setWideUrls((previous) => new Set(previous).add(url));
                  }}
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
