'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  getMangaChapters,
  getSourceChapterPages,
  getDownloadedChapterPages,
  buildDownloadedPageUrl,
  buildImageProxyUrl,
  buildApiUrl,
  markChapterByLastPage,
  markChapterAsRead,
  addHistory,
  hasLocalDataBridge,
  type MangaChapterRecord,
} from '@projekt-manga/api-client';
import type { Manga } from '@/lib/manga-data';
import {
  useReaderSettings,
  SCROLL_SPEED_MIN,
  SCROLL_SPEED_MAX,
  SCROLL_SPEED_STEP,
  AUTO_SCROLL_PIXELS_PER_SECOND,
  formatScrollSpeed,
} from '@/lib/reader-settings';
import { useWakeLock } from '@/lib/use-wake-lock';
import { useReadingClock } from '@/lib/use-reading-clock';
import { ReaderHeader } from '@/components/reader/reader-header';
import { PagedViewer } from '@/components/reader/paged-viewer';
import { LongStripViewer } from '@/components/reader/long-strip-viewer';
import { ReaderProgressBar } from '@/components/reader/reader-progress-bar';
import { usePagePrefetch } from '@/components/reader/use-page-prefetch';
import { reportError } from '@/lib/report-error';
import { queueReaderProgressBeacons } from '@/lib/reader-progress-beacon';
import { invalidateSavedReadingProgress } from '@/lib/query-client';
import { useProfilePreference, useReadingQueue } from '@/lib/profile-preferences';
import { Pause, Play } from 'lucide-react';
import { ReaderSpeedSlider } from '@/components/reader/reader-speed-slider';
import { libraryActions, useLibraryState, useMangaLibrary } from '@/lib/library-store';
import {
  parseChapterParam,
  parsePreferredGroup,
  selectChapterRelease,
} from '@/lib/reader-preferences';
import { ReaderPersonalTools } from '@/components/reader/reader-personal-tools';
import { isSourceIncognito, useSourceIncognito } from '@/lib/incognito';
import { useAutoAdvanceCountdown } from '@/lib/auto-advance';

/** How long the reader chrome stays up after the last thing the reader did. */
const CHROME_IDLE_MS = 2200;

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.5;
const ZOOM_STEP = 0.25;

function positiveIntParam(searchParams: URLSearchParams, key: string): number | undefined {
  const raw = Number(searchParams.get(key));
  return Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

export function ReaderPageClient({ manga }: { manga: Manga }) {
  const incognito = useSourceIncognito(manga.source);
  const searchParams = useSearchParams();
  const router = useRouter();
  const requestedChapter = parseChapterParam(searchParams.get('ch')) ?? manga.currentChapter ?? 1;
  const requestedPage = positiveIntParam(searchParams, 'page');
  const requestedChapterId = searchParams.get('chapterId');
  const [queue, setQueue] = useReadingQueue();
  const { manga: library } = useMangaLibrary();
  const queuedIds = queue.filter((id) => id !== manga.id);
  const nextQueued = queuedIds.map((id) => library.find((item) => item.id === id)).find(Boolean);
  const missingQueued = queuedIds.some((id) => !library.some((item) => item.id === id));
  const [preferredGroup, setPreferredGroup] = useProfilePreference(
    `reader-group:${manga.source}:${manga.id}`,
    parsePreferredGroup,
    '',
  );
  const [loadedImages, setLoadedImages] = useState<Set<string>>(new Set());
  const {
    effectiveLayout,
    readingDirection,
    immersiveMode: immersiveSetting,
    preloadNextChapter,
    pagePrefetchAhead,
    chapterPrefetchCount,
    offsetFirstPage,
    showPageNumber,
    keepScreenAwake,
    background,
    brightness,
    stripGap,
    tapActions,
    autoAdvance,
    zoomBehavior,
    hideChromeOnScroll,
    scrollSpeed,
    autoScroll: autoScrollOnOpen,
    autoScrollSpeed,
    autoScrollPixelsPerSecond,
  } = useReaderSettings(manga.source, manga.id);

  useWakeLock(keepScreenAwake);

  const [chapters, setChapters] = useState<MangaChapterRecord[]>([]);
  const [chaptersLoaded, setChaptersLoaded] = useState(false);
  const [chaptersError, setChaptersError] = useState(false);
  const [chaptersRetry, setChaptersRetry] = useState(0);
  const [pagesError, setPagesError] = useState(false);
  const [pagesRetry, setPagesRetry] = useState(0);
  const [chapter, setChapter] = useState(requestedChapter);
  // Tagged with the chapter it was fetched for — derived `pageUrls` below only ever
  // exposes it when the tag matches the *current* chapter, so a resolved fetch for a
  // chapter we've since navigated away from can never render under the wrong number,
  // no matter what raced what.
  const [pagesData, setPagesData] = useState<{
    chapter: number;
    chapterId: string;
    urls: string[];
  } | null>(null);
  const [page, setPage] = useState(requestedPage ?? 1);
  const [zoom, setZoom] = useState(1);
  // Seeded from the setting, then toggled for the session by the "F" key. The initial
  // useState value is the *pre-hydration* default (the store only reads localStorage in an
  // effect), so it has to be re-synced once the real setting arrives — otherwise turning
  // immersive mode off in Settings would have no effect on a fresh load.
  const [immersive, setImmersive] = useState(immersiveSetting);
  const longStrip = effectiveLayout === 'Long strip';
  const longStripRef = useRef(longStrip);
  longStripRef.current = longStrip;
  const [autoScrolling, setAutoScrolling] = useState(autoScrollOnOpen && longStrip);
  // Follows the setting, and stops as soon as the layout stops being one that scrolls.
  useEffect(() => {
    setAutoScrolling(autoScrollOnOpen && longStrip);
  }, [autoScrollOnOpen, longStrip]);
  useEffect(() => {
    setImmersive(immersiveSetting);
  }, [immersiveSetting]);
  const [chromeShown, setChromeShown] = useState(true);

  const chapterByNumber = useMemo(() => {
    const map = new Map<number, MangaChapterRecord>();
    for (const c of chapters) {
      if (!map.has(c.chapter_number) || (preferredGroup && c.scanlator === preferredGroup))
        map.set(c.chapter_number, c);
    }
    if (requestedChapterId) {
      const explicit = chapters.find((record) => record.id === requestedChapterId);
      if (explicit) map.set(explicit.chapter_number, explicit);
    }
    return map;
  }, [chapters, preferredGroup, requestedChapterId]);
  // Chapter numbers are not contiguous integers (10.3, 11.1, 11.2 …), so "next"/"previous"
  // must come from the real sorted list rather than ±1.
  const sortedChapterNumbers = useMemo(
    () => [...new Set(chapters.map((c) => c.chapter_number))].sort((a, b) => a - b),
    [chapters],
  );
  const nextChapterAfter = (n: number): number | null =>
    sortedChapterNumbers.find((c) => c > n) ?? null;
  const prevChapterBefore = (n: number): number | null =>
    [...sortedChapterNumbers].reverse().find((c) => c < n) ?? null;

  const maxChapter = chapters.reduce((max, c) => Math.max(max, c.chapter_number), 0);
  const currentRecord = chapterByNumber.get(chapter);
  const pageUrls =
    pagesData?.chapter === chapter && pagesData.chapterId === currentRecord?.id
      ? pagesData.urls
      : [];
  const invalidChapterId =
    chaptersLoaded &&
    requestedChapterId !== null &&
    !chapters.some((record) => record.id === requestedChapterId);
  const imageReady = currentRecord && loadedImages.has(`${currentRecord.id}:${page}`);
  const onPageReady = (chapterNumber: number, pageNumber: number) => {
    const record = chapterByNumber.get(chapterNumber);
    if (!record) return;
    setLoadedImages((previous) => {
      const key = `${record.id}:${pageNumber}`;
      if (previous.has(key)) return previous;
      return new Set(previous).add(key);
    });
  };
  const title = currentRecord?.name ?? `Chapter ${chapter}`;
  // The chapter's real page total, or 0 while still unknown. Sources vary: some report a
  // count on the chapter list (usable immediately), others report 0 and only reveal the
  // real number once the pages themselves are fetched — which in webtoon mode happens
  // inside LongStripViewer, so it reports back up here. 0 means "don't guess yet", and
  // callers that need a number for layout fall back to 1 explicitly.
  const [observedTotal, setObservedTotal] = useState<{ chapter: number; total: number } | null>(
    null,
  );
  const knownTotal =
    (observedTotal?.chapter === chapter ? observedTotal.total : 0) ||
    (pagesData?.chapter === chapter ? pageUrls.length : 0) ||
    currentRecord?.page_count ||
    0;
  const totalPages = knownTotal || 1;

  usePagePrefetch(pageUrls, page, pagePrefetchAhead);

  useEffect(() => {
    const controller = new AbortController();
    setChaptersError(false);
    getMangaChapters(manga.id, manga.slug, manga.source, controller.signal)
      .then((rows) => {
        if (!controller.signal.aborted) {
          setChapters(
            rows.filter((record) => record.manga_id === null || record.manga_id === manga.id),
          );
          setChaptersLoaded(true);
        }
      })
      // Next/previous chapter and the chapter panel all read from this; failing quietly
      // leaves them inert with no explanation.
      .catch((error) => {
        if (!controller.signal.aborted) {
          setChaptersError(true);
          reportError(error, "Couldn't load this title's chapter list.");
        }
      });
    return () => controller.abort();
  }, [manga.id, manga.slug, manga.source, chaptersRetry]);

  /**
   * Downloaded pages first, live source second.
   *
   * A downloaded chapter is served from disk, so it reads without touching the source at
   * all — which is the whole point of downloading one. The lookup 404s for any chapter
   * that was never downloaded (the common case), so that isn't an error worth surfacing:
   * falling through to the source is the handling, and a real source failure still
   * surfaces from the call below.
   */
  const fetchPages = async (chapterNumber: number): Promise<string[]> => {
    const record = chapterByNumber.get(chapterNumber);
    if (!record) return [];

    try {
      const offline = await getDownloadedChapterPages(record.id);
      if (offline.length > 0) {
        return offline
          .slice()
          .sort((a, b) => a.index - b.index)
          .map((p) => buildDownloadedPageUrl(record.id, p.index));
      }
    } catch {
      // Not downloaded, or the stored files went missing — read it from the source.
    }

    const result = await getSourceChapterPages(manga.source, record.id, { mangaSlug: manga.slug });
    return result.items
      .sort((a, b) => a.index - b.index)
      .map((p) => (p.image_url ? buildImageProxyUrl(p.image_url, manga.source) : ''))
      .filter(Boolean);
  };

  // An explicit chapter change from outside (chapter list, a Link, browser back/forward,
  // or our own router.replace calls below — all of which encode the target page too, so
  // this never clobbers a page an internal navigation just set).
  //
  // Zoom is deliberately left alone here. This effect runs on every chapter change,
  // including ones the reader didn't ask for (Long Strip auto-advancing into the next
  // chapter). Resetting zoom there would reflow the strip, and LongStripViewer rescales
  // scrollTop by the zoom ratio, so the scroll position would jump. Zoom only changes via
  // zoomIn/zoomOut/zoomReset, as a session preference rather than a per-chapter default.
  useEffect(() => {
    if (chapters.length === 0 || effectiveLayout === 'Long strip' || invalidChapterId) return;
    let cancelled = false;
    const targetChapter = chapter;
    setPagesError(false);
    fetchPages(targetChapter)
      .then((urls) => {
        if (!cancelled) {
          setPagesData({
            chapter: targetChapter,
            chapterId: chapterByNumber.get(targetChapter)?.id ?? '',
            urls,
          });
          setPagesError(urls.length === 0);
        }
      })
      .catch(() => {
        if (!cancelled) setPagesError(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    chapter,
    chapters,
    effectiveLayout,
    pagesRetry,
    requestedChapterId,
    preferredGroup,
    invalidChapterId,
  ]);

  // When nearing the end of the current chapter, warm the next chapter's first page so
  // stepping across the boundary doesn't stall on a fresh chapter-pages fetch. Gated on
  // the *current* chapter's own real pages already being loaded (not just the metadata
  // page_count, which some sources — e.g. MangaGeko — never populate, leaving it 0) so
  // this never fires a next-chapter scrape concurrently with the current chapter's own
  // still-in-flight one.
  const preloadedChapters = useRef(new Set<number>());
  useEffect(() => {
    if (!preloadNextChapter || effectiveLayout === 'Long strip') return;
    if (pageUrls.length === 0) return;
    // The trigger distance follows the page-prefetch window, so raising one doesn't leave
    // the other reaching across the chapter boundary too late to help.
    const trigger = Math.max(1, pagePrefetchAhead);
    if (pageUrls.length - page > trigger) return;

    // Settings > Reader > Chapters to preload: walk that many chapters forward.
    const upcoming: number[] = [];
    let cursor = chapter;
    for (let i = 0; i < chapterPrefetchCount; i++) {
      const next = nextChapterAfter(cursor);
      if (next === null) break;
      upcoming.push(next);
      cursor = next;
    }
    if (upcoming.length === 0) return;

    let cancelled = false;
    // Sequential, not parallel: several concurrent chapter scrapes against one source is
    // exactly the traffic pattern that gets a scraper rate-limited.
    void (async () => {
      for (const target of upcoming) {
        if (cancelled) return;
        // This effect re-runs on every page turn near the boundary; don't redo finished work.
        if (preloadedChapters.current.has(target)) continue;
        try {
          const urls = await fetchPages(target);
          if (cancelled || urls.length === 0) return;
          const img = new window.Image();
          img.src = urls[0];
          preloadedChapters.current.add(target);
        } catch {
          return;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    preloadNextChapter,
    chapterPrefetchCount,
    pagePrefetchAhead,
    chapter,
    page,
    pageUrls,
    maxChapter,
    effectiveLayout,
    chapters,
  ]);

  const zoomIn = () => setZoom((z) => Math.min(ZOOM_MAX, Math.round((z + ZOOM_STEP) * 100) / 100));
  const zoomOut = () => setZoom((z) => Math.max(ZOOM_MIN, Math.round((z - ZOOM_STEP) * 100) / 100));
  const zoomReset = () => setZoom(1);

  /**
   * Set while the reader is scrolling down, so the inactivity timer below does not
   * immediately undo the hide.
   *
   * Scrolling fires `mousemove` on some setups and `touchstart` on every phone, and both
   * of those mean "reveal" to the timer — without this the chrome would reappear a frame
   * after the scroll hid it, reading as a flicker.
   */
  const scrolledAway = useRef(false);

  /**
   * True while the pointer is over the reader chrome, or focus is inside it.
   *
   * Controls that move the page — zoom, the auto-scroll toggle, the speed sliders — are
   * *in* the bar they would otherwise dismiss. Hiding a control at the moment it is being
   * used is never what the reader meant, whatever the scroll position did.
   */
  const chromeHovered = useRef(false);
  /**
   * Actually *engaged* with the chrome: a pointer held down on it, or focus inside it.
   *
   * Narrower than hover on purpose. Hovering is enough to stop a scroll from dismissing
   * the bar — a click on zoom reflows the strip, and the pointer is still over the button
   * when that scroll event lands. It is not enough to stop the idle timer: a pointer
   * parked at the top of the screen is not someone using the controls, and treating it as
   * such would keep the bar up indefinitely.
   */
  const chromeEngaged = useRef(false);
  /** Hovering a control counts as engagement; hovering the bar's empty space does not. */
  const overControl = (target: EventTarget | null) =>
    target instanceof Element && !!target.closest('button, a, input, select, [role="slider"]');

  const chromeInteraction = {
    onPointerEnter: () => {
      chromeHovered.current = true;
    },
    // The bar is full-width, so a pointer parked at the top of the screen sits on it
    // without meaning anything by it. Poised over a button or a slider is different: that
    // one must not disappear as it is reached for.
    onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => {
      chromeHovered.current = true;
      chromeEngaged.current = overControl(event.target);
    },
    onPointerLeave: () => {
      chromeHovered.current = false;
      chromeEngaged.current = false;
    },
    onPointerDown: () => {
      chromeEngaged.current = true;
    },
    onFocusCapture: () => {
      chromeEngaged.current = true;
    },
    onBlurCapture: (event: React.FocusEvent<HTMLDivElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
        chromeEngaged.current = false;
      }
    },
  };

  // A drag can finish anywhere, including outside the bar it started in.
  useEffect(() => {
    const release = () => {
      chromeEngaged.current = false;
    };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    return () => {
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
    };
  }, []);

  /**
   * One owner of the chrome's visibility, and of the timer that hides it.
   *
   * Scrolling and the inactivity timer must not set `chromeShown` independently, or they
   * fight: scrolling back up reveals the bars and a timer still counting down from the
   * last mouse move hides them again a moment later. Every reveal restarts the timer and
   * every hide cancels it, so the last thing the reader did is the thing that decides.
   */
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const immersiveRef = useRef(immersive);
  immersiveRef.current = immersive;

  const revealChrome = useCallback(() => {
    setChromeShown(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (!immersiveRef.current) return;
    hideTimer.current = setTimeout(() => {
      // Never mid-interaction — a slider being dragged, or focus sitting in the bar.
      if (chromeEngaged.current) return;
      setChromeShown(false);
    }, CHROME_IDLE_MS);
  }, []);

  const hideChrome = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setChromeShown(false);
  }, []);

  useEffect(() => () => void (hideTimer.current && clearTimeout(hideTimer.current)), []);

  const onScrollDirection = useCallback(
    (direction: 'up' | 'down') => {
      if (!hideChromeOnScroll) return;
      if (direction === 'up') {
        scrolledAway.current = false;
        revealChrome();
        return;
      }
      // Scrolling down only hides when the reader is not at the controls. Hover counts
      // here: zoom reflows the strip, and the pointer is still on the button when that
      // scroll event arrives.
      if (chromeHovered.current || chromeEngaged.current) return;
      scrolledAway.current = true;
      hideChrome();
    },
    [hideChromeOnScroll, revealChrome, hideChrome],
  );

  /**
   * While immersive, the chrome auto-hides after a couple of seconds and comes back on
   * activity — but what counts as activity depends on the layout.
   *
   * In a paged layout nothing the reader does moves the page except paging itself, so
   * reacting to mouse movement would bring the bars back whenever the pointer crossed the
   * window, over the top of the page being read. There the tap zones are the control
   * surface (Settings > Reader > Tap zones, "Controls" by default on the centre third),
   * so after the first auto-hide the chrome stays put until something explicitly asks for
   * it. Key presses still reveal it: paging with the arrow keys is reading, and a
   * keyboard user has no tap zone.
   *
   * The long strip keeps pointer and touch reveals, because there scrolling is the
   * reading gesture and hide-on-scroll is what the chrome follows.
   */
  useEffect(() => {
    if (!immersive) {
      setChromeShown(true);
      return;
    }
    const reveal = () => {
      // Deliberately not clearing `scrolledAway`: only scrolling back up should do that,
      // or the first stray mouse move would cancel the hide.
      if (scrolledAway.current) return;
      revealChrome();
    };
    reveal();
    window.addEventListener('keydown', reveal);
    if (longStrip) {
      window.addEventListener('mousemove', reveal);
      window.addEventListener('touchstart', reveal);
    }
    return () => {
      window.removeEventListener('keydown', reveal);
      window.removeEventListener('mousemove', reveal);
      window.removeEventListener('touchstart', reveal);
    };
  }, [immersive, longStrip, revealChrome]);

  // Reader shortcuts: arrows/space page through (paged layouts only — long strip scrolls
  // natively), "f" toggles immersive chrome, "+"/"=" zoom in, "-" out, "0" resets zoom.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Leave browser shortcuts (Ctrl +/-/0 zoom, Ctrl+F find) alone.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target instanceof Element ? e.target : null;
      // Buttons and links are not excluded: none of these keys activate them, and a
      // control the reader just clicked keeps focus, which would otherwise kill the shortcuts.
      if (
        document.querySelector('[role="dialog"]') ||
        el?.closest('input,textarea,select,[contenteditable="true"],[role="menu"]')
      )
        return;
      if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        zoomIn();
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        zoomOut();
      } else if (e.key === '0') {
        e.preventDefault();
        zoomReset();
      } else if (e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setImmersive((v) => !v);
      } else if (e.key.toLowerCase() === 'a' && longStripRef.current) {
        // Only where there is something to scroll — in a paged layout "a" would toggle a
        // control the reader cannot see and nothing would happen.
        e.preventDefault();
        setAutoScrolling((v) => !v);
      }
      // Arrow/space paging is handled inside PagedViewer itself (it owns the scroll
      // container that IntersectionObserver tracks position from).
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /* ----------------------------------------------------- progress persistence */

  // Latest position worth saving, kept in a ref so the flush paths (debounce timer,
  // unmount, tab close) always send the newest value rather than a stale closure's.
  const pendingProgress = useRef<{
    chapterId: string;
    page: number;
    pageCount: number;
  } | null>(null);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  /** Chapters already auto-marked read this session, so reaching the end repeatedly
   * (scrolling back and forth over the last page) doesn't re-fire the request. */
  const autoReadSent = useRef(new Set<string>());
  const takeElapsed = useReadingClock();
  useEffect(() => {
    takeElapsed();
  }, [incognito, takeElapsed]);

  const flushProgress = useCallback(
    (useBeacon = false) => {
      if (isSourceIncognito(manga.source)) {
        pendingProgress.current = null;
        return;
      }
      const pending = pendingProgress.current;
      if (!pending) return;
      pendingProgress.current = null;
      if (flushTimer.current) {
        clearTimeout(flushTimer.current);
        flushTimer.current = null;
      }

      const path = `/chapter/${encodeURIComponent(manga.slug)}/${encodeURIComponent(pending.chapterId)}/${pending.page}/mark-by-page`;
      const body = { page_count: pending.pageCount, source: manga.source };
      // Time since the last flush, not a running total — the server adds it to what it
      // already has. Reading it here means it's taken exactly once per flush.
      const history = {
        source: manga.source,
        manga_id: manga.id,
        manga_slug: manga.slug,
        title: manga.title,
        chapter_id: pending.chapterId,
        pages_read: pending.page,
        time_read: takeElapsed(),
      };

      // On tab close/hide a normal fetch is often killed mid-flight; sendBeacon is the
      // one transport the browser promises to finish.
      if (useBeacon && !hasLocalDataBridge()) {
        const queued = queueReaderProgressBeacons(
          buildApiUrl(path),
          body,
          buildApiUrl('/history/add'),
          history,
        );
        if (queued?.progressQueued || queued?.historyQueued) invalidateSavedReadingProgress();
        if (queued?.progressQueued && queued.historyQueued) return;
        if (queued?.progressQueued) {
          addHistory(history)
            .then(invalidateSavedReadingProgress)
            .catch((error) => reportError(error, "Your reading progress isn't being saved."));
          return;
        }
        if (queued?.historyQueued) {
          markChapterByLastPage(manga.slug, pending.chapterId, pending.page, body)
            .then(invalidateSavedReadingProgress)
            .catch((error) => reportError(error, "Your reading progress isn't being saved."));
          return;
        }
      }

      // Deduped inside reportError, deliberately: this fires on every page turn, and a
      // toast per page would be unusable. Losing your place silently is the worse
      // outcome of the two, so it is worth saying once.
      saveQueue.current = saveQueue.current.then(async () => {
        if (isSourceIncognito(manga.source)) return;
        await Promise.all([
          markChapterByLastPage(manga.slug, pending.chapterId, pending.page, body)
            .then(invalidateSavedReadingProgress)
            .catch((error) => reportError(error, "Your reading progress isn't being saved.")),
          addHistory(history).catch((error) =>
            reportError(error, "Your reading progress isn't being saved."),
          ),
        ]);
      });
    },
    [manga.id, manga.slug, manga.source, manga.title, takeElapsed],
  );

  useEffect(() => {
    const target = requestedChapterId
      ? chapters.find((record) => record.id === requestedChapterId)?.chapter_number
      : requestedChapter;
    if (target === undefined) return;
    if (chapter !== target) flushProgress();
    setChapter(target);
    setPage(requestedPage ?? 1);
    // Respond to URL changes, not stream-position state updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedChapter, requestedChapterId, requestedPage, chapters.length, flushProgress]);

  // Queue the current position, debounced — paging quickly through a chapter shouldn't
  // fire a write per page. Deliberately gated on a *known* page total: before the pages
  // resolve we'd otherwise persist a meaningless "page 1 of 1" over real saved progress.
  useEffect(() => {
    const record = chapterByNumber.get(chapter);
    if (incognito || !record || knownTotal === 0 || !imageReady || invalidChapterId) return;

    pendingProgress.current = {
      chapterId: record.id,
      page: Math.min(page, knownTotal),
      pageCount: knownTotal,
    };

    if (flushTimer.current) clearTimeout(flushTimer.current);
    flushTimer.current = setTimeout(() => flushProgress(), 800);
    return () => {
      if (flushTimer.current) clearTimeout(flushTimer.current);
    };
  }, [
    chapter,
    page,
    knownTotal,
    chapterByNumber,
    flushProgress,
    imageReady,
    invalidChapterId,
    incognito,
  ]);

  // Save immediately when the reader leaves — closing/hiding the tab, or unmounting
  // (exiting the reader, or switching chapters, which swaps the pending payload anyway).
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') flushProgress(true);
    };
    const onPageHide = () => flushProgress(true);
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onPageHide);
      flushProgress();
    };
  }, [flushProgress]);

  // Finishing the last page marks the chapter read, without the reader having to do it
  // by hand. Only fires on a real, known page total and only once per chapter.
  useEffect(() => {
    const record = chapterByNumber.get(chapter);
    if (incognito || !record || knownTotal === 0 || !imageReady || invalidChapterId) return;
    if (page < knownTotal) return;
    if (record.is_read || autoReadSent.current.has(record.id)) return;

    autoReadSent.current.add(record.id);
    markChapterAsRead(manga.slug, record.id, { page_count: knownTotal, source: manga.source })
      .then(() => {
        invalidateSavedReadingProgress();
        // Reflect it locally so the header/chapter list update without a refetch.
        setChapters((prev) => prev.map((c) => (c.id === record.id ? { ...c, is_read: true } : c)));
      })
      .catch(() => autoReadSent.current.delete(record.id));
  }, [
    chapter,
    page,
    knownTotal,
    chapterByNumber,
    manga.slug,
    manga.source,
    imageReady,
    invalidChapterId,
    incognito,
  ]);

  const goToPage = (p: number) => setPage(Math.max(1, Math.min(totalPages, p)));

  /** Moves to another chapter, keeping the URL (chapter + page) in sync without a full
   * route reload — the page is encoded too so the URL-driven effect above lands on the
   * same page we set directly, instead of resetting it back to 1. */
  const goToChapter = (target: number, atPage: number) => {
    if (!Number.isFinite(target) || target < 0 || !chapterByNumber.has(target)) return;
    flushProgress();
    setChapter(target);
    setPage(atPage);
    const record = selectChapterRelease(chapters, target, preferredGroup);
    router.replace(
      `/reader/${manga.id}?ch=${target}&page=${atPage}${record ? `&chapterId=${encodeURIComponent(record.id)}` : ''}`,
    );
  };

  const pagesPerView = effectiveLayout === 'Single page' ? 1 : 2;

  const nextChapter = nextChapterAfter(chapter);
  const prevChapter = prevChapterBefore(chapter);
  const hasNextChapter = nextChapter !== null;
  const hasPrevChapter = prevChapter !== null;
  // Opening a library title that sits on no shelf files it under Reading, so the library
  // header's "in progress" count matches the Continue reading card. A shelf the reader
  // chose themselves is never changed.
  const { shelf, loading: shelfLoading } = useLibraryState();
  const inLibrary = library.some((item) => item.id === manga.id);
  const filedAsReading = useRef(false);
  useEffect(() => {
    if (filedAsReading.current || shelfLoading || !inLibrary || !imageReady || incognito) return;
    filedAsReading.current = true;
    if (!shelf[manga.id]) void libraryActions.setShelf(manga.id, 'reading').catch(() => {});
  }, [shelfLoading, inLibrary, imageReady, incognito, shelf, manga.id]);

  const autoAdvanceCountdown = useAutoAdvanceCountdown(
    !!autoAdvance &&
      !!currentRecord &&
      !!imageReady &&
      page >= totalPages &&
      nextChapter !== null &&
      effectiveLayout !== 'Long strip',
    currentRecord?.id,
    () => {
      if (nextChapter !== null) goToChapter(nextChapter, 1);
    },
  );

  /** Reaching the end/start of the chapter's own page strip only ever surfaces an
   * explicit "continue" panel (see PagedViewer) — it never jumps chapters on its own. */
  const requestNextChapter = () => {
    if (nextChapter !== null) goToChapter(nextChapter, 1);
  };
  const requestPrevChapter = () => {
    if (prevChapter === null) return;
    goToChapter(prevChapter, chapterByNumber.get(prevChapter)?.page_count || 1);
  };

  // Long strip streams chapter-to-chapter itself; only sync the URL when the chapter
  // it's currently showing actually changes, so page-only scroll doesn't spam history.
  const handleStreamPosition = (streamChapter: number, streamPage: number, streamTotal: number) => {
    if (streamChapter !== chapter) {
      setChapter(streamChapter);
      // Carry the page too: without it the URL-driven effect would reset position to
      // page 1 of the chapter the reader just scrolled into.
      router.replace(`/reader/${manga.id}?ch=${streamChapter}&page=${streamPage}`);
    }
    setPage(streamPage);
    // Webtoon mode fetches pages itself, so this is where the parent learns the real
    // total — needed for progress ("10 / 22") and the auto-mark-read check.
    if (streamTotal > 0) setObservedTotal({ chapter: streamChapter, total: streamTotal });
  };

  // Faded-out chrome must also leave the tab order and accessibility tree; a keydown
  // (see the immersive effect) brings it back.
  const chromeHidden = immersive && !chromeShown;
  const chromeWrap = immersive
    ? `fixed inset-x-0 z-30 transition-opacity duration-300 ${chromeShown ? 'opacity-100' : 'pointer-events-none opacity-0'}`
    : '';

  if (invalidChapterId)
    return (
      <div
        role="alert"
        className="fixed inset-0 z-50 grid place-content-center gap-4 bg-background p-6 text-center"
      >
        This chapter release does not belong to this title.
        <button
          type="button"
          onClick={() => router.replace(`/reader/${manga.id}?ch=${requestedChapter}`)}
          className="rounded border p-3"
        >
          Open the chapter list
        </button>
        <button type="button" onClick={() => router.push('/')} className="rounded border p-3">
          Return to library
        </button>
      </div>
    );

  const completionActions = (
    <>
      {effectiveLayout === 'Long strip' && (
        <button
          type="button"
          className="rounded border border-white/20 px-4 py-2"
          onClick={requestNextChapter}
        >
          {hasNextChapter ? `Next chapter ${nextChapter}` : 'No next chapter available'}
        </button>
      )}
      <button
        type="button"
        className="rounded border border-white/20 px-4 py-2"
        onClick={() => router.push('/')}
      >
        Return to library
      </button>
      {nextQueued && (
        <button
          type="button"
          className="rounded border border-white/20 px-4 py-2"
          onClick={() => {
            setQueue(
              queue.filter(
                (id) =>
                  id !== manga.id && id !== nextQueued.id && library.some((item) => item.id === id),
              ),
            );
            router.push(
              `/reader/${nextQueued.id}?ch=${nextQueued.currentChapter ?? 1}&page=${nextQueued.currentPage || 1}`,
            );
          }}
        >
          Read next: {nextQueued.title}
        </button>
      )}
      {missingQueued && (
        <p role="status" className="text-xs">
          Unavailable queued titles are skipped.
        </p>
      )}
    </>
  );

  return (
    <div className="fixed inset-0 z-50 flex flex-col" style={{ background }}>
      {/* Settings > Reader > Brightness. Sits above the pages at z-20; the header,
          progress bar, page counter and paging arrows are all z-30, so the controls stay
          legible however far the brightness is turned down. */}
      {brightness < 100 && (
        <div
          aria-hidden
          className="pointer-events-none fixed inset-0 z-20 bg-black"
          style={{ opacity: (100 - brightness) / 100 }}
        />
      )}
      {/* Always present for screen readers, even while the reader chrome is hidden. */}
      <h1 className="sr-only">
        {manga.title}, Chapter {chapter}
      </h1>
      <div
        {...chromeInteraction}
        inert={chromeHidden}
        aria-hidden={chromeHidden || undefined}
        className={immersive ? `${chromeWrap} top-0` : chromeShown ? 'relative z-30' : 'hidden'}
      >
        <ReaderHeader
          manga={manga}
          chapters={chapters}
          chapter={chapter}
          chapterId={currentRecord?.id}
          title={incognito ? `Incognito · ${title}` : title}
          zoom={zoom}
          zoomMin={ZOOM_MIN}
          zoomMax={ZOOM_MAX}
          onZoomIn={zoomIn}
          onZoomOut={zoomOut}
          onZoomReset={zoomReset}
        />
        <div className="flex flex-wrap items-center justify-center gap-2 bg-black/80 px-3 py-1 text-xs text-white">
          {longStrip && (
            <ReaderSpeedSlider
              label="Scroll"
              settingKey="readerScrollSpeed"
              value={scrollSpeed}
              min={SCROLL_SPEED_MIN}
              max={SCROLL_SPEED_MAX}
              step={SCROLL_SPEED_STEP}
              format={formatScrollSpeed}
            />
          )}
          {longStrip && (
            <button
              type="button"
              onClick={() => setAutoScrolling((v) => !v)}
              aria-pressed={autoScrolling}
              // The label says what pressing it does, which is what a screen reader reads
              // out; aria-pressed carries the current state separately.
              aria-label={autoScrolling ? 'Stop auto-scrolling' : 'Start auto-scrolling'}
              title="Auto-scroll (A)"
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 transition ${
                autoScrolling
                  ? 'border-primary/60 bg-primary/20 text-primary'
                  : 'border-white/20 text-white/70 hover:border-white/40 hover:text-white'
              }`}
            >
              {autoScrolling ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
              Auto-scroll
            </button>
          )}
          {/* Only while it is running: a speed control for something that is not moving
              has nothing to show for being dragged. */}
          {longStrip && autoScrolling && (
            <ReaderSpeedSlider
              label="Speed"
              settingKey="readerAutoScrollSpeed"
              value={autoScrollSpeed}
              min={1}
              max={AUTO_SCROLL_PIXELS_PER_SECOND.length}
              step={1}
              format={(value) => `${value}×`}
            />
          )}
          <label>
            Translation group{' '}
            <select
              aria-label="Translation group"
              value={currentRecord?.id ?? ''}
              onChange={(event) => {
                const record = chapters.find((item) => item.id === event.target.value);
                if (!record) return;
                flushProgress();
                setPreferredGroup(record.scanlator ?? '');
                setPagesData(null);
                router.replace(
                  `/reader/${manga.id}?ch=${record.chapter_number}&page=1&chapterId=${encodeURIComponent(record.id)}`,
                );
              }}
              className="rounded border border-white/20 bg-black p-1"
            >
              {chapters
                .filter((record) => record.chapter_number === chapter)
                .map((record) => (
                  <option key={record.id} value={record.id}>
                    {record.scanlator || 'Unknown group'}
                  </option>
                ))}
            </select>
          </label>
          {preferredGroup && currentRecord && currentRecord.scanlator !== preferredGroup && (
            <span role="status">
              {preferredGroup} has no release here; using{' '}
              {currentRecord.scanlator || 'an available group'}.
            </span>
          )}
          <ReaderPersonalTools
            source={manga.source}
            mangaId={manga.id}
            chapterId={currentRecord?.id}
            page={page}
          />
        </div>
      </div>

      {effectiveLayout === 'Long strip' ? (
        <LongStripViewer
          key={`${manga.id}:${preferredGroup}`}
          manga={manga}
          ready={chapters.length > 0 && !invalidChapterId}
          startChapter={chapter}
          startPage={page}
          getNextChapter={nextChapterAfter}
          getChapterTitle={(n) => chapterByNumber.get(n)?.name ?? `Chapter ${n}`}
          getChapterPageCount={(n) => chapterByNumber.get(n)?.page_count ?? 0}
          fetchPages={fetchPages}
          onPositionChange={handleStreamPosition}
          zoom={zoom}
          pageGap={stripGap}
          autoAdvance={autoAdvance}
          onPageReady={onPageReady}
          completionActions={completionActions}
          getChapterIdentity={(number) => chapterByNumber.get(number)?.id ?? ''}
          releaseVersion={requestedChapterId}
          onScrollDirection={onScrollDirection}
          scrollSpeed={scrollSpeed}
          autoScrollPixelsPerSecond={autoScrolling ? autoScrollPixelsPerSecond : 0}
        />
      ) : (
        <PagedViewer
          key={currentRecord?.id ?? chapter}
          manga={manga}
          page={page}
          totalPages={totalPages}
          pageUrls={pageUrls}
          pagesPerView={pagesPerView}
          readingDirection={readingDirection}
          onPositionChange={setPage}
          hasNextChapter={hasNextChapter}
          nextChapterNumber={nextChapter ?? 0}
          onRequestNextChapter={requestNextChapter}
          hasPrevChapter={hasPrevChapter}
          prevChapterNumber={prevChapter ?? 0}
          onRequestPrevChapter={requestPrevChapter}
          zoom={zoom}
          offsetFirstPage={offsetFirstPage}
          onPageReady={(p) => onPageReady(chapter, p)}
          tapActions={tapActions}
          onToggleControls={() => setChromeShown((value) => !value)}
          completionActions={completionActions}
          fitOverride={zoomBehavior}
          autoAdvanceSecondsLeft={autoAdvanceCountdown.secondsLeft}
          onCancelAutoAdvance={autoAdvanceCountdown.cancel}
        />
      )}

      {chaptersError && (
        <div
          role="alert"
          className="fixed inset-x-4 top-20 z-40 mx-auto max-w-md rounded-xl border border-destructive/40 bg-black/90 p-4 text-center text-sm text-white"
        >
          Couldn&apos;t load the chapter list.
          <button
            type="button"
            onClick={() => setChaptersRetry((value) => value + 1)}
            className="ml-2 text-primary hover:underline"
          >
            Try again
          </button>
        </div>
      )}
      {pagesError && effectiveLayout !== 'Long strip' && (
        <div
          role="alert"
          className="fixed inset-x-4 top-20 z-40 mx-auto max-w-md rounded-xl border border-destructive/40 bg-black/90 p-4 text-center text-sm text-white"
        >
          Couldn&apos;t load this chapter&apos;s pages.
          <button
            type="button"
            onClick={() => setPagesRetry((value) => value + 1)}
            className="ml-2 text-primary hover:underline"
          >
            Try again
          </button>
        </div>
      )}

      {showPageNumber && (
        <div className="pointer-events-none fixed bottom-16 right-5 z-30 rounded-full bg-black/60 px-3 py-1 text-[11px] font-medium tabular-nums text-white/80 backdrop-blur">
          {page} / {totalPages}
        </div>
      )}

      <div
        {...chromeInteraction}
        inert={chromeHidden}
        aria-hidden={chromeHidden || undefined}
        className={immersive ? `${chromeWrap} bottom-0` : 'relative z-30'}
      >
        <ReaderProgressBar page={page} totalPages={totalPages} onSeek={goToPage} />
      </div>
    </div>
  );
}
