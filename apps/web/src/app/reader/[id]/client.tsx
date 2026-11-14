'use client';

import { useEffect, useRef, useState } from 'react';
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
import { fetchDownloads } from '@/lib/shared-queries';
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
import { toast } from '@/hooks/use-toast';
import { useReaderInput } from '@/components/reader/use-reader-input';
import { useChapterOrder } from '@/components/reader/use-chapter-order';
import { useNextChapterPreload } from '@/components/reader/use-next-chapter-preload';
import { useReaderChrome } from '@/components/reader/use-reader-chrome';
import { ReaderShortcuts } from '@/components/reader/reader-shortcuts';
import { WebtoonSuggestion } from '@/components/reader/webtoon-suggestion';
import { setPageAsCover } from '@/components/reader/set-page-as-cover';
import { LinkedSourceFallback } from '@/components/reader/linked-source-fallback';
import { ReaderContextMenu } from '@/components/reader/reader-context-menu';

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

  const {
    chapterByNumber,
    sortedChapterNumbers,
    currentRecord,
    nextChapterAfter,
    nextChapter,
    prevChapter,
    nextRelease,
    prevRelease,
    byRelease,
    stopIndexOf,
    stripStop,
    nextStopAfter,
    isBookmarked,
    toggleChapterBookmark,
  } = useChapterOrder({
    mangaId: manga.id,
    chapters,
    chapter,
    preferredGroup,
    requestedChapterId,
  });
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

  useNextChapterPreload({
    enabled: preloadNextChapter && effectiveLayout !== 'Long strip',
    chapter,
    page,
    pageUrls,
    pagePrefetchAhead,
    chapterPrefetchCount,
    nextChapterAfter,
    fetchPages,
  });

  const {
    shown: chromeShown,
    interaction: chromeInteraction,
    onScrollDirection,
    toggle: toggleChrome,
  } = useReaderChrome({ immersive, longStrip, hideChromeOnScroll });

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

  // Settings > Downloads > Download ahead: keep the next chapters downloaded while
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
      // Settings > Downloads > Delete after reading. Best effort, never blocks reading.
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
          loadPageUrls={() => fetchPages(chapter)}
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
              onToggleControls={toggleChrome}
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
