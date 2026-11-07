'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SelectMenu } from '@/components/ui/select-menu';
import { Button } from '@/components/ui/button';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  getMangaChapters,
  getSourceChapterPages,
  getDownloadedChapterPages,
  buildDownloadedPageUrl,
  buildImageProxyUrl,
  markChapterAsRead,
  type MangaChapterRecord,
} from '@projekt-manga/api-client';
import type { Manga } from '@/lib/manga-data';
import {
  useReaderSettings,
  ReaderColorFilterContext,
  SCROLL_SPEED_MIN,
  SCROLL_SPEED_MAX,
  SCROLL_SPEED_STEP,
  AUTO_SCROLL_PIXELS_PER_SECOND,
  formatScrollSpeed,
} from '@/lib/reader-settings';
import { useWakeLock } from '@/lib/use-wake-lock';
import { ReaderHeader } from '@/components/reader/reader-header';
import { PagedViewer } from '@/components/reader/paged-viewer';
import { LongStripViewer } from '@/components/reader/long-strip-viewer';
import { ReaderProgressBar } from '@/components/reader/reader-progress-bar';
import { usePagePrefetch } from '@/components/reader/use-page-prefetch';
import { useChapterPages, useLoadedPage } from '@/components/reader/use-chapter-pages';
import { useAutoMarkRead, useReaderProgress } from '@/components/reader/use-reader-progress';
import { reportError } from '@/lib/report-error';
import { fetchDownloads, useDownloads } from '@/lib/shared-queries';
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
import { ReaderTintOverlay } from '@/components/reader/reader-tint';
import { afterChapterRead, downloadAhead } from '@/lib/auto-downloads';
import { markDuplicatesRead } from '@/lib/chapter-gaps';
import { useSourceIncognito } from '@/lib/incognito';
import { useAutoAdvanceCountdown } from '@/lib/auto-advance';
import { useReaderZoom, ZOOM_MAX, ZOOM_MIN } from '@/lib/reader-zoom';
import {
  SKIP_DUPLICATE_CHAPTERS,
  SKIP_READ_CHAPTERS,
  adjacentChapter,
  adjacentRelease,
  releaseStops,
} from '@/lib/chapter-skip';
import {
  DEFAULT_CHAPTER_FILTER,
  SKIP_FILTERED_CHAPTERS,
  chapterFilterKey,
  isFilterActive,
  parseChapterFilter,
  releasePassesFilter,
} from '@/lib/chapter-filter';
import { useChapterBookmarks } from '@/lib/chapter-bookmarks';
import { toast } from '@/hooks/use-toast';
import { useSetting } from '@/lib/app-store';
import { useReaderInput } from '@/components/reader/use-reader-input';
import { ReaderShortcuts } from '@/components/reader/reader-shortcuts';
import { WebtoonSuggestion } from '@/components/reader/webtoon-suggestion';
import { setPageAsCover } from '@/components/reader/set-page-as-cover';
import { LinkedSourceFallback } from '@/components/reader/linked-source-fallback';
import { ReaderContextMenu } from '@/components/reader/reader-context-menu';

/** How long the reader chrome stays up after the last thing the reader did. */
const CHROME_IDLE_MS = 2200;

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
  // A release is named by row id (`chapterId`), or by the source's key (`chapterKey`) when
  // the link came from a source listing, which has no row ids.
  const requestedRowId = searchParams.get('chapterId');
  const requestedChapterKey = searchParams.get('chapterKey');
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
    colorFilter,
    tint,
    tintStrength,
  } = useReaderSettings(manga.source, manga.id);

  useWakeLock(keepScreenAwake);

  const [chapters, setChapters] = useState<MangaChapterRecord[]>([]);
  const requestedChapterId =
    requestedRowId ??
    (requestedChapterKey
      ? (chapters.find((record) => record.source_chapter_key === requestedChapterKey)?.id ??
        requestedChapterKey)
      : null);
  const [chaptersLoaded, setChaptersLoaded] = useState(false);
  const [chaptersError, setChaptersError] = useState(false);
  const [chaptersRetry, setChaptersRetry] = useState(0);
  const [chapter, setChapter] = useState(requestedChapter);
  const [page, setPage] = useState(requestedPage ?? 1);
  const { zoom, setZoom, zoomIn, zoomOut, zoomReset } = useReaderZoom();
  const [looksLikeWebtoon, setLooksLikeWebtoon] = useState(false);
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
  // Settings › Reader › Skip read chapters / Skip filtered chapters. A release is passed
  // over when it is read, or when the title's chapter-list filter hides it; a chapter
  // number is passed over when every release of it is.
  const skipRead = useSetting(SKIP_READ_CHAPTERS, false) as boolean;
  const skipFiltered = useSetting(SKIP_FILTERED_CHAPTERS, false) as boolean;
  const skipDuplicates = useSetting(SKIP_DUPLICATE_CHAPTERS, false) as boolean;
  const [listFilter] = useProfilePreference(
    chapterFilterKey(manga.id),
    parseChapterFilter,
    DEFAULT_CHAPTER_FILTER,
  );
  const filtering = skipFiltered && isFilterActive(listFilter);
  const bookmarkTargets = useMemo(
    () => chapters.map((c) => ({ id: c.source_chapter_key, is_bookmark: c.is_bookmark })),
    [chapters],
  );
  const { isBookmarked, toggle: toggleChapterBookmark } = useChapterBookmarks(bookmarkTargets);
  // Only fetched when the filter is "Downloaded", the one filter that needs it.
  const { data: filterDownloads } = useDownloads({
    enabled: filtering && listFilter.status === 'Downloaded',
  });
  const downloadedIds: ReadonlySet<string> = useMemo(
    () =>
      new Set(
        (filterDownloads ?? [])
          .filter((d) => d.status === 'COMPLETED' && d.chapter_id)
          .map((d) => d.chapter_id),
      ),
    [filterDownloads],
  );
  const skipRelease = (record: MangaChapterRecord) =>
    (skipRead && record.is_read) ||
    (filtering &&
      !releasePassesFilter(record, listFilter, { downloaded: downloadedIds, isBookmarked }));
  const releasesByNumber = useMemo(() => {
    const map = new Map<number, MangaChapterRecord[]>();
    for (const c of chapters) map.set(c.chapter_number, [...(map.get(c.chapter_number) ?? []), c]);
    return map;
  }, [chapters]);
  const skipChapter = (n: number) =>
    (skipRead || filtering) && (releasesByNumber.get(n) ?? []).every(skipRelease);
  const nextChapterAfter = (n: number): number | null =>
    adjacentChapter(sortedChapterNumbers, n, 1, skipChapter);
  const prevChapterBefore = (n: number): number | null =>
    adjacentChapter(sortedChapterNumbers, n, -1, skipChapter);

  const currentRecord = chapterByNumber.get(chapter);
  const invalidChapterId =
    chaptersLoaded &&
    requestedChapterId !== null &&
    !chapters.some((record) => record.id === requestedChapterId);
  const { imageReady, markPageLoaded } = useLoadedPage(currentRecord?.id, page);
  const onPageReady = (chapterNumber: number, pageNumber: number) => {
    const record = chapterByNumber.get(chapterNumber);
    if (record) markPageLoaded(record.id, pageNumber);
  };

  /**
   * Downloaded pages first, live source second: a downloaded chapter is served from disk, so
   * it reads without touching the source at all, which is the whole point of downloading it.
   * The download list says which those are. If it can't be read, the lookup is tried anyway:
   * it answers 404 for a chapter that was never downloaded, and falling through to the
   * source is the handling for that.
   */
  const fetchReleasePages = async (record: MangaChapterRecord): Promise<string[]> => {
    const downloads = await fetchDownloads().catch(() => null);
    const maybeOffline =
      !downloads ||
      downloads.some((item) => item.chapter_id === record.id && item.status === 'COMPLETED');
    if (maybeOffline) {
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
    }

    const result = await getSourceChapterPages(manga.source, record.source_chapter_key, {
      mangaSlug: manga.slug,
    });
    return result.items
      .sort((a, b) => a.index - b.index)
      .map((p) => (p.image_url ? buildImageProxyUrl(p.image_url, manga.source) : ''))
      .filter(Boolean);
  };

  const { pageUrls, pagesError, pagesFor, retryPages } = useChapterPages({
    chapter,
    record: currentRecord,
    enabled: chapters.length > 0 && effectiveLayout !== 'Long strip' && !invalidChapterId,
    load: fetchReleasePages,
  });
  const fetchPages = (chapterNumber: number): Promise<string[]> => {
    const record = chapterByNumber.get(chapterNumber);
    return record ? pagesFor(record) : Promise.resolve([]);
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
    pageUrls.length ||
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

  // When nearing the end of the current chapter, warm the next chapter's first page so
  // stepping across the boundary doesn't stall on a fresh chapter-pages fetch. Gated on
  // the *current* chapter's own real pages already being loaded (not just the metadata
  // page_count, which some sources — e.g. MangaGeko — never populate, leaving it 0) so
  // this never fires a next-chapter scrape concurrently with the current chapter's own
  // still-in-flight one.
  const nextChapterRef = useRef(nextChapterAfter);
  nextChapterRef.current = nextChapterAfter;
  const fetchPagesRef = useRef(fetchPages);
  fetchPagesRef.current = fetchPages;
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
  }, [
    preloadNextChapter,
    chapterPrefetchCount,
    pagePrefetchAhead,
    chapter,
    page,
    pageUrls,
    effectiveLayout,
  ]);

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

  /* ----------------------------------------------------- progress persistence */

  const progressRecord = chapterByNumber.get(chapter);
  const canSave = !incognito && !!progressRecord && knownTotal > 0 && !!imageReady;
  const { flushProgress } = useReaderProgress(
    {
      source: manga.source,
      mangaSlug: manga.slug,
      history: { manga_id: manga.id, title: manga.title },
    },
    canSave && !invalidChapterId
      ? {
          sourceChapterKey: progressRecord.source_chapter_key,
          page: Math.min(page, knownTotal),
          pageCount: knownTotal,
          body: { page_count: knownTotal, source: manga.source },
        }
      : null,
  );

  // Follows the URL: the chapter list, a Link, browser back/forward, or our own
  // router.replace calls below, all of which encode the target page too, so this never
  // clobbers a page an internal navigation just set. Applied once per address, so a change
  // to the chapter list can't throw the reader back to the page the address started on.
  const appliedAddress = useRef<string | null>(null);
  const addressState = useRef({ chapter, flushProgress });
  addressState.current = { chapter, flushProgress };
  const requestedTarget = requestedChapterId
    ? chapters.find((record) => record.id === requestedChapterId)?.chapter_number
    : requestedChapter;
  useEffect(() => {
    if (requestedTarget === undefined) return;
    const address = `${requestedTarget}:${requestedChapterId}:${requestedPage}`;
    if (appliedAddress.current === address) return;
    appliedAddress.current = address;
    if (addressState.current.chapter !== requestedTarget) addressState.current.flushProgress();
    setChapter(requestedTarget);
    setPage(requestedPage ?? 1);
  }, [requestedTarget, requestedChapterId, requestedPage]);

  // Settings > Sync & Storage > Download ahead: keep the next chapters downloaded while
  // reading. Once per chapter opened, and never in incognito.
  const downloadAheadFor = useRef<number | null>(null);
  const downloadAheadRef = useRef(() => {});
  downloadAheadRef.current = () => {
    void downloadAhead(manga, chapter, sortedChapterNumbers, (number) =>
      chapterByNumber.get(number),
    ).catch(() => undefined);
  };
  useEffect(() => {
    if (incognito || chapters.length === 0 || downloadAheadFor.current === chapter) return;
    downloadAheadFor.current = chapter;
    downloadAheadRef.current();
  }, [chapter, chapters.length, incognito]);

  // Finishing the last page marks the chapter read.
  const finishedRecord =
    canSave && !invalidChapterId && page >= knownTotal && !progressRecord.is_read
      ? progressRecord
      : null;
  useAutoMarkRead(finishedRecord?.id ?? null, () => {
    const record = finishedRecord!;
    return markChapterAsRead(manga.slug, record.source_chapter_key, {
      page_count: knownTotal,
      source: manga.source,
    }).then(() => {
      invalidateSavedReadingProgress();
      // Reflect it locally so the header/chapter list update without a refetch.
      setChapters((prev) => prev.map((c) => (c.id === record.id ? { ...c, is_read: true } : c)));
      // Settings > Sync & Storage > Delete after reading. Best effort, never blocks reading.
      void afterChapterRead(manga, record.chapter_number, sortedChapterNumbers, (number) =>
        chapterByNumber.get(number),
      ).catch(() => undefined);
      // Settings > Reader > Mark duplicates read. Best effort, like the line above.
      void markDuplicatesRead(manga, chapters, record.chapter_number, record.id)
        .then((marked) => {
          if (marked.length === 0) return;
          const ids = new Set(marked);
          setChapters((prev) => prev.map((c) => (ids.has(c.id) ? { ...c, is_read: true } : c)));
        })
        .catch(() => undefined);
    });
  });

  const goToPage = (p: number) => setPage(Math.max(1, Math.min(totalPages, p)));

  /** Moves to another chapter, keeping the URL (chapter + page) in sync without a full
   * route reload — the page is encoded too so the URL-driven effect above lands on the
   * same page we set directly, instead of resetting it back to 1. */
  const goToChapter = (target: number, atPage: number, releaseId?: string) => {
    if (!Number.isFinite(target) || target < 0 || !chapterByNumber.has(target)) return;
    flushProgress();
    setChapter(target);
    setPage(atPage);
    const record =
      (releaseId && chapters.find((c) => c.id === releaseId)) ||
      selectChapterRelease(chapters, target, preferredGroup);
    router.replace(
      `/reader/${manga.id}?ch=${target}&page=${atPage}${record ? `&chapterId=${encodeURIComponent(record.id)}` : ''}`,
    );
  };

  const pagesPerView = effectiveLayout === 'Single page' ? 1 : 2;

  // Settings › Reader › Skip duplicate chapters, off: each group's release of a chapter is
  // its own stop, so next and previous move between releases rather than numbers.
  const stops = useMemo(
    () => (skipDuplicates ? [] : releaseStops(chapters, preferredGroup, currentRecord?.id)),
    [skipDuplicates, chapters, preferredGroup, currentRecord?.id],
  );
  const byRelease = !skipDuplicates && !!currentRecord;
  const nextRelease = byRelease ? adjacentRelease(stops, currentRecord, 1, skipRelease) : null;
  const prevRelease = byRelease ? adjacentRelease(stops, currentRecord, -1, skipRelease) : null;
  const nextChapter = byRelease ? (nextRelease?.chapter_number ?? null) : nextChapterAfter(chapter);
  const prevChapter = byRelease
    ? (prevRelease?.chapter_number ?? null)
    : prevChapterBefore(chapter);
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
      if (nextChapter !== null) goToChapter(nextChapter, 1, nextRelease?.id);
    },
  );

  /** Reaching the end/start of the chapter's own page strip only ever surfaces an
   * explicit "continue" panel (see PagedViewer) — it never jumps chapters on its own. */
  const requestNextChapter = () => {
    if (nextChapter !== null) goToChapter(nextChapter, 1, nextRelease?.id);
  };
  const requestPrevChapter = () => {
    if (prevChapter === null) return;
    goToChapter(
      prevChapter,
      (prevRelease ?? chapterByNumber.get(prevChapter))?.page_count || 1,
      prevRelease?.id,
    );
  };

  /** The chapter list's bookmark, kept by the source's key, so both show the same. */
  const toggleCurrentBookmark = () => {
    if (!currentRecord) return;
    const key = currentRecord.source_chapter_key;
    const next = !isBookmarked(key);
    toggleChapterBookmark(key);
    toast({ description: next ? `Bookmarked ${title}` : `Removed the bookmark from ${title}` });
  };

  // Settings › Reader › Keyboard. Page turning belongs to the viewers, which own the
  // scroll position; the chapter list to the header.
  useReaderInput({
    zoomIn,
    zoomOut,
    zoomReset,
    toggleControls: () => setImmersive((v) => !v),
    // Only where there is something to scroll — in a paged layout the key would toggle
    // a control the reader cannot see.
    autoScroll: () => {
      if (!longStripRef.current) return false;
      setAutoScrolling((v) => !v);
    },
    nextChapter: () => {
      if (nextChapter === null) return false;
      requestNextChapter();
    },
    bookmarkChapter: () => {
      if (!currentRecord) return false;
      toggleCurrentBookmark();
    },
    prevChapter: () => {
      if (prevChapter === null) return false;
      requestPrevChapter();
    },
  });

  // Long strip streams chapter-to-chapter itself; only sync the URL when the chapter
  // it's currently showing actually changes, so page-only scroll doesn't spam history.
  // Long strip with "Skip duplicate chapters" off: the strip runs through the same stops as
  // next/previous in the paged reader, each group's release in turn. Its segments are
  // numbered by position in `stops` (stable: `keep` only swaps which release of one
  // chapter-and-group stands for it), and translated back to releases here.
  const stopIndexOf = (record: MangaChapterRecord | undefined) => {
    if (!record) return -1;
    const exact = stops.findIndex((stop) => stop.id === record.id);
    if (exact !== -1) return exact;
    const next = adjacentRelease(stops, record, 1);
    const previous = adjacentRelease(stops, record, -1);
    return stops.indexOf(
      stops.find(
        (stop) =>
          stop.chapter_number === record.chapter_number &&
          (stop.scanlator ?? '') === (record.scanlator ?? ''),
      ) ??
        next ??
        previous ??
        stops[0],
    );
  };
  const stripStop = (index: number) => stops[index];
  const nextStopAfter = (index: number): number | null => {
    const stop = stripStop(index);
    const next = stop ? adjacentRelease(stops, stop, 1, skipRelease) : null;
    return next ? stops.indexOf(next) : null;
  };
  const handleStripRelease = (index: number, streamPage: number, streamTotal: number) => {
    const record = stripStop(index);
    if (!record) return;
    if (record.id !== currentRecord?.id) {
      setChapter(record.chapter_number);
      router.replace(
        `/reader/${manga.id}?ch=${record.chapter_number}&page=${streamPage}&chapterId=${encodeURIComponent(record.id)}`,
      );
    }
    setPage(streamPage);
    if (streamTotal > 0) setObservedTotal({ chapter: record.chapter_number, total: streamTotal });
  };

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
        <p className="text-sm text-foreground">
          This chapter release does not belong to this title.
        </p>
        <Button onClick={() => router.replace(`/reader/${manga.id}?ch=${requestedChapter}`)}>
          Open the chapter list
        </Button>
        <Button variant="outline" onClick={() => router.push('/')}>
          Return to library
        </Button>
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
    <ReaderColorFilterContext.Provider value={colorFilter}>
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
        <ReaderTintOverlay tint={tint} strength={tintStrength} />
        <ReaderShortcuts />
        {/* Linked sources: this chapter won't load, or the title has no next chapter here. */}
        <LinkedSourceFallback
          mangaId={manga.id}
          chapterNumber={chapter}
          need={
            pagesError
              ? 'same'
              : chaptersLoaded && nextChapter === null && page >= totalPages
                ? 'next'
                : null
          }
        />
        <WebtoonSuggestion
          source={manga.source}
          mangaId={manga.id}
          visible={looksLikeWebtoon && effectiveLayout !== 'Long strip'}
          base={{
            zoomBehavior,
            brightness,
            stripGap,
            pagePrefetchAhead,
            chapterPrefetchCount,
            colorFilter,
            tint,
            tintStrength,
          }}
        />
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
            page={page}
            pageImageUrl={pageUrls[page - 1]}
            bookmarked={currentRecord ? isBookmarked(currentRecord.source_chapter_key) : false}
            onToggleBookmark={currentRecord ? toggleCurrentBookmark : undefined}
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
            <div className="flex items-center gap-2">
              Translation group
              <SelectMenu
                label="Translation group"
                value={currentRecord?.id ?? ''}
                onChange={(id) => {
                  const record = chapters.find((item) => item.id === id);
                  if (!record) return;
                  flushProgress();
                  setPreferredGroup(record.scanlator ?? '');
                  router.replace(
                    `/reader/${manga.id}?ch=${record.chapter_number}&page=1&chapterId=${encodeURIComponent(record.id)}`,
                  );
                }}
                options={chapters
                  .filter((record) => record.chapter_number === chapter)
                  .map((record) => ({
                    value: record.id,
                    label: record.scanlator || 'Unknown group',
                  }))}
              />
            </div>
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

        <ReaderContextMenu
          pageUrls={pageUrls}
          page={page}
          mangaTitle={manga.title}
          chapter={chapter}
          onSetCover={(url) => void setPageAsCover(manga.id, url)}
        >
          {effectiveLayout === 'Long strip' ? (
            <LongStripViewer
              key={`${manga.id}:${preferredGroup}:${byRelease ? 'releases' : 'numbers'}`}
              manga={manga}
              ready={chapters.length > 0 && !invalidChapterId}
              startPage={page}
              {...(byRelease
                ? {
                    startChapter: Math.max(0, stopIndexOf(currentRecord)),
                    getNextChapter: nextStopAfter,
                    getChapterLabel: (i: number) => {
                      const stop = stripStop(i);
                      return stop
                        ? `Chapter ${stop.chapter_number}${stop.scanlator ? ` · ${stop.scanlator}` : ''}`
                        : '';
                    },
                    getChapterTitle: (i: number) => stripStop(i)?.name ?? '',
                    getChapterPageCount: (i: number) => stripStop(i)?.page_count ?? 0,
                    fetchPages: (i: number) => {
                      const stop = stripStop(i);
                      return stop ? pagesFor(stop) : Promise.resolve([]);
                    },
                    onPositionChange: handleStripRelease,
                    onPageReady: (i: number, p: number) => {
                      const stop = stripStop(i);
                      if (stop) onPageReady(stop.chapter_number, p);
                    },
                    getChapterIdentity: (i: number) => stripStop(i)?.id ?? '',
                  }
                : {
                    startChapter: chapter,
                    getNextChapter: nextChapterAfter,
                    getChapterTitle: (n: number) => chapterByNumber.get(n)?.name ?? `Chapter ${n}`,
                    getChapterPageCount: (n: number) => chapterByNumber.get(n)?.page_count ?? 0,
                    fetchPages,
                    onPositionChange: handleStreamPosition,
                    onPageReady,
                    getChapterIdentity: (n: number) => chapterByNumber.get(n)?.id ?? '',
                  })}
              zoom={zoom}
              pageGap={stripGap}
              autoAdvance={autoAdvance}
              completionActions={completionActions}
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
              onZoomChange={setZoom}
              offsetFirstPage={offsetFirstPage}
              onPageReady={(p) => onPageReady(chapter, p)}
              tapActions={tapActions}
              onToggleControls={() => setChromeShown((value) => !value)}
              completionActions={completionActions}
              fitOverride={zoomBehavior}
              autoAdvanceSecondsLeft={autoAdvanceCountdown.secondsLeft}
              onCancelAutoAdvance={autoAdvanceCountdown.cancel}
              onLooksLikeWebtoon={() => setLooksLikeWebtoon(true)}
            />
          )}
        </ReaderContextMenu>

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
              onClick={retryPages}
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
    </ReaderColorFilterContext.Provider>
  );
}
