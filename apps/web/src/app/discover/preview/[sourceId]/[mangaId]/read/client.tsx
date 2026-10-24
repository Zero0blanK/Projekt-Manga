'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { MangaDetails } from '@projekt-manga/types';
import {
  getSourceChapterPages,
  buildImageProxyUrl,
  buildApiUrl,
  markChapterByLastPage,
  markChapterAsRead,
  addHistory,
  hasLocalDataBridge,
} from '@projekt-manga/api-client';
import { invalidateSavedReadingProgress } from '@/lib/query-client';
import { fromSourceDetails } from '@/lib/manga-data';
import { useReaderSettings } from '@/lib/reader-settings';
import { useWakeLock } from '@/lib/use-wake-lock';
import { useReadingClock } from '@/lib/use-reading-clock';
import { PagedViewer } from '@/components/reader/paged-viewer';
import { LongStripViewer } from '@/components/reader/long-strip-viewer';
import { ReaderProgressBar } from '@/components/reader/reader-progress-bar';
import { ReaderSettingsMenu } from '@/components/reader/reader-settings-menu';
import { usePagePrefetch } from '@/components/reader/use-page-prefetch';
import { ExitReaderButton } from '@/components/reader/exit-reader-button';
import { reportError } from '@/lib/report-error';
import { queueReaderProgressBeacons } from '@/lib/reader-progress-beacon';
import { X, ZoomIn, ZoomOut, List } from 'lucide-react';
import { useProfilePreference } from '@/lib/profile-preferences';
import { parseChapterParam, parsePreferredGroup } from '@/lib/reader-preferences';
import { ReaderPersonalTools } from '@/components/reader/reader-personal-tools';
import { isSourceIncognito, useSourceIncognito } from '@/lib/incognito';
import { useAutoAdvanceCountdown } from '@/lib/auto-advance';

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.5;
const ZOOM_STEP = 0.25;

function positiveNumberParam(params: URLSearchParams, key: string): number | undefined {
  const raw = Number(params.get(key));
  return Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

/**
 * Reads a source title without creating a manga row. Progress and history are keyed by
 * source + manga_slug (+ chapter id) — both columns' manga_id is nullable — so a title
 * you never added still resumes where you left off and shows up in History, carrying its
 * own title/cover rather than relying on a `manga` join that doesn't exist.
 */
export function SourceReaderClient({
  sourceId,
  details,
}: {
  sourceId: string;
  details: MangaDetails;
}) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const manga = useMemo(() => fromSourceDetails(details, sourceId), [details, sourceId]);
  const requestedChapterId = searchParams.get('chapterId');
  const [preferredGroup, setPreferredGroup] = useProfilePreference(
    `reader-group:${sourceId}:${details.id}`,
    parsePreferredGroup,
    '',
  );
  const [loadedImages, setLoadedImages] = useState<Set<string>>(new Set());
  const [chromeShown, setChromeShown] = useState(true);

  const {
    effectiveLayout,
    readingDirection,
    pagePrefetchAhead,
    offsetFirstPage,
    showPageNumber,
    keepScreenAwake,
    background,
    brightness,
    stripGap,
    autoAdvance,
    tapActions,
    zoomBehavior,
  } = useReaderSettings(sourceId, details.id);

  useWakeLock(keepScreenAwake);

  const chapters = useMemo(
    () => [...(details.chapters ?? [])].sort((a, b) => a.chapter_number - b.chapter_number),
    [details.chapters],
  );
  const chapterByNumber = useMemo(() => {
    const map = new Map<number, (typeof chapters)[number]>();
    for (const c of chapters) {
      if (!map.has(c.chapter_number) || (preferredGroup && c.scanlator === preferredGroup))
        map.set(c.chapter_number, c);
    }
    const explicit = chapters.find((record) => record.id === requestedChapterId);
    if (explicit) map.set(explicit.chapter_number, explicit);
    return map;
  }, [chapters, requestedChapterId, preferredGroup]);
  const sortedNumbers = useMemo(() => chapters.map((c) => c.chapter_number), [chapters]);

  const requestedChapter =
    chapters.find((entry) => entry.id === requestedChapterId)?.chapter_number ??
    parseChapterParam(searchParams.get('ch')) ??
    sortedNumbers[0] ??
    1;
  const requestedPage = positiveNumberParam(searchParams, 'page');

  const [chapter, setChapter] = useState(requestedChapter);
  const [page, setPage] = useState(requestedPage ?? 1);
  const [zoom, setZoom] = useState(1);
  const [chapterListOpen, setChapterListOpen] = useState(false);
  const [pagesData, setPagesData] = useState<{
    chapter: number;
    chapterId: string;
    urls: string[];
  } | null>(null);
  const [pagesError, setPagesError] = useState(false);
  const [pagesRetry, setPagesRetry] = useState(0);
  const [observedTotal, setObservedTotal] = useState<{ chapter: number; total: number } | null>(
    null,
  );

  const currentRecord = chapterByNumber.get(chapter);
  const pageUrls =
    pagesData?.chapter === chapter && pagesData.chapterId === currentRecord?.id
      ? pagesData.urls
      : [];
  const invalidChapterId =
    requestedChapterId !== null && !chapters.some((record) => record.id === requestedChapterId);
  const imageReady = Boolean(currentRecord && loadedImages.has(`${currentRecord.id}:${page}`));
  const onPageReady = (number: number, p: number) => {
    const record = chapterByNumber.get(number);
    if (!record) return;
    setLoadedImages((previous) => new Set(previous).add(`${record.id}:${p}`));
  };
  const knownTotal =
    (observedTotal?.chapter === chapter ? observedTotal.total : 0) ||
    pageUrls.length ||
    currentRecord?.page_count ||
    0;
  const totalPages = knownTotal || 1;

  usePagePrefetch(pageUrls, page, pagePrefetchAhead);

  // Zoom is deliberately left alone here — see the same effect in the library reader
  // (app/reader/[id]/client.tsx) for why resetting it on every chapter change breaks
  // Long Strip mode's auto-advance-while-scrolling.
  const fetchPages = useCallback(
    async (chapterNumber: number): Promise<string[]> => {
      const record = chapterByNumber.get(chapterNumber);
      if (!record) return [];
      const result = await getSourceChapterPages(sourceId, record.id, { mangaSlug: details.slug });
      return result.items
        .sort((a, b) => a.index - b.index)
        .map((p) => (p.image_url ? buildImageProxyUrl(p.image_url, sourceId) : ''))
        .filter(Boolean);
    },
    [chapterByNumber, sourceId, details.slug],
  );

  useEffect(() => {
    if (chapters.length === 0 || effectiveLayout === 'Long strip' || invalidChapterId) return;
    let cancelled = false;
    const target = chapter;
    setPagesError(false);
    fetchPages(target)
      .then((urls) => {
        if (!cancelled) {
          setPagesData({ chapter: target, chapterId: chapterByNumber.get(target)?.id ?? '', urls });
          setPagesError(urls.length === 0);
        }
      })
      .catch(() => {
        if (!cancelled) setPagesError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [
    chapter,
    chapters,
    effectiveLayout,
    fetchPages,
    pagesRetry,
    invalidChapterId,
    chapterByNumber,
  ]);

  /* ------------------------------------------------- progress + history (no manga row) */

  const pending = useRef<{
    chapterId: string;
    chapterNumber: number;
    name: string;
    url: string;
    page: number;
    pageCount: number;
  } | null>(null);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const autoReadSent = useRef(new Set<string>());
  const takeElapsed = useReadingClock();
  const incognito = useSourceIncognito(sourceId);
  useEffect(() => {
    takeElapsed();
  }, [incognito, takeElapsed]);

  const flush = useCallback(
    (useBeacon = false) => {
      if (isSourceIncognito(sourceId)) {
        pending.current = null;
        return;
      }
      const p = pending.current;
      if (!p) return;
      pending.current = null;
      if (flushTimer.current) {
        clearTimeout(flushTimer.current);
        flushTimer.current = null;
      }

      // chapter.manga_id and history.manga_id are both nullable, so these persist against
      // the slug alone. `title` is sent explicitly because there's no manga row to join to.
      const path = `/chapter/${encodeURIComponent(details.slug)}/${encodeURIComponent(p.chapterId)}/${p.page}/mark-by-page`;
      const body = {
        source: sourceId,
        chapter_number: p.chapterNumber,
        name: p.name,
        url: p.url,
        page_count: p.pageCount,
      };
      const history = {
        source: sourceId,
        manga_slug: details.slug,
        source_manga_id: details.id,
        title: details.title,
        thumbnail_url: details.thumbnail_url || undefined,
        chapter_id: p.chapterId,
        pages_read: p.page,
        // Increment since the last flush — the server adds it to the stored total.
        time_read: takeElapsed(),
      };

      // On tab close/hide a normal fetch is often killed mid-flight; sendBeacon is the
      // one transport the browser promises to finish — see the same guard in the library
      // reader (app/reader/[id]/client.tsx's flushProgress), which this mirrors so a
      // preview read doesn't lose progress/history that a library read wouldn't.
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
          markChapterByLastPage(details.slug, p.chapterId, p.page, body)
            .then(invalidateSavedReadingProgress)
            .catch((error) => reportError(error, "Your reading progress isn't being saved."));
          return;
        }
      }

      saveQueue.current = saveQueue.current.then(async () => {
        if (isSourceIncognito(sourceId)) return;
        await Promise.all([
          markChapterByLastPage(details.slug, p.chapterId, p.page, body)
            .then(invalidateSavedReadingProgress)
            .catch((error) => reportError(error, "Your reading progress isn't being saved.")),
          addHistory(history).catch((error) =>
            reportError(error, "Your reading progress isn't being saved."),
          ),
        ]);
      });
    },
    [details.id, details.slug, details.title, details.thumbnail_url, sourceId, takeElapsed],
  );

  useEffect(() => {
    if (chapter !== requestedChapter) flush();
    setChapter(requestedChapter);
    setPage(requestedPage ?? 1);
    // Only the URL is authoritative here; streamed chapter updates have their own path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedChapter, requestedPage, flush]);

  useEffect(() => {
    const record = chapterByNumber.get(chapter);
    if (incognito || !record || knownTotal === 0 || !imageReady || invalidChapterId) return;
    pending.current = {
      chapterId: record.id,
      chapterNumber: record.chapter_number,
      name: record.name,
      url: record.url,
      page: Math.min(page, knownTotal),
      pageCount: knownTotal,
    };
    if (flushTimer.current) clearTimeout(flushTimer.current);
    flushTimer.current = setTimeout(() => flush(), 800);
    return () => {
      if (flushTimer.current) clearTimeout(flushTimer.current);
    };
  }, [chapter, page, knownTotal, chapterByNumber, flush, imageReady, invalidChapterId, incognito]);

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') flush(true);
    };
    const onPageHide = () => flush(true);
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onPageHide);
      flush();
    };
  }, [flush]);

  useEffect(() => {
    const record = chapterByNumber.get(chapter);
    if (
      incognito ||
      !record ||
      knownTotal === 0 ||
      page < knownTotal ||
      !imageReady ||
      invalidChapterId
    )
      return;
    if (autoReadSent.current.has(record.id)) return;
    autoReadSent.current.add(record.id);
    markChapterAsRead(details.slug, record.id, {
      source: sourceId,
      chapter_number: record.chapter_number,
      name: record.name,
      url: record.url,
      page_count: knownTotal,
    })
      .then(invalidateSavedReadingProgress)
      .catch(() => autoReadSent.current.delete(record.id));
  }, [
    chapter,
    page,
    knownTotal,
    chapterByNumber,
    details.slug,
    sourceId,
    imageReady,
    invalidChapterId,
    incognito,
  ]);

  /* ------------------------------------------------------------------ navigation */

  const nextChapterAfter = (n: number): number | null => sortedNumbers.find((c) => c > n) ?? null;
  const prevChapterBefore = (n: number): number | null =>
    [...sortedNumbers].reverse().find((c) => c < n) ?? null;
  const nextChapter = nextChapterAfter(chapter);
  const prevChapter = prevChapterBefore(chapter);

  const basePath = `/discover/preview/${encodeURIComponent(sourceId)}/${encodeURIComponent(details.id)}`;
  const goToChapter = (target: number, atPage: number, releaseId?: string) => {
    flush();
    setChapter(target);
    setPage(atPage);
    const record = releaseId
      ? chapters.find((item) => item.id === releaseId)
      : (chapters.find(
          (item) =>
            item.chapter_number === target && preferredGroup && item.scanlator === preferredGroup,
        ) ?? chapters.find((item) => item.chapter_number === target));
    router.replace(
      `${basePath}/read?ch=${target}&page=${atPage}${record ? `&chapterId=${encodeURIComponent(record.id)}` : ''}`,
    );
  };

  const zoomIn = () => setZoom((z) => Math.min(ZOOM_MAX, Math.round((z + ZOOM_STEP) * 100) / 100));
  const zoomOut = () => setZoom((z) => Math.max(ZOOM_MIN, Math.round((z - ZOOM_STEP) * 100) / 100));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable))
        return;
      if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        zoomIn();
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        zoomOut();
      } else if (e.key === '0') {
        e.preventDefault();
        setZoom(1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const title = currentRecord?.name || `Chapter ${chapter}`;
  const autoAdvanceCountdown = useAutoAdvanceCountdown(
    !!autoAdvance &&
      effectiveLayout !== 'Long strip' &&
      !!currentRecord &&
      !!imageReady &&
      page >= totalPages &&
      nextChapter !== null,
    currentRecord?.id,
    () => {
      if (nextChapter !== null) goToChapter(nextChapter, 1);
    },
  );
  if (invalidChapterId)
    return (
      <div
        role="alert"
        className="fixed inset-0 z-50 grid place-content-center gap-4 bg-background p-6 text-center"
      >
        This chapter release does not belong to this source title.
        <button
          type="button"
          onClick={() => router.replace(basePath)}
          className="rounded border p-3"
        >
          Return to title
        </button>
      </div>
    );
  const completionActions = (
    <>
      {effectiveLayout === 'Long strip' && nextChapter !== null && (
        <button
          type="button"
          className="rounded border border-white/20 px-4 py-2"
          onClick={() => goToChapter(nextChapter, 1)}
        >
          Next chapter {nextChapter}
        </button>
      )}
      <button
        type="button"
        className="rounded border border-white/20 px-4 py-2"
        onClick={() => router.push('/')}
      >
        Return to library
      </button>
    </>
  );

  return (
    <div className="fixed inset-0 z-50 flex flex-col" style={{ background }}>
      {/* Settings > Reader > Brightness — see the library reader for the rationale. */}
      {brightness < 100 && (
        <div
          aria-hidden
          className="pointer-events-none fixed inset-0 z-20 bg-black"
          style={{ opacity: (100 - brightness) / 100 }}
        />
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
      <div
        className={
          chromeShown
            ? 'relative z-30 flex h-14 shrink-0 items-center gap-4 border-b border-white/10 bg-black/80 px-4 backdrop-blur-xl'
            : 'hidden'
        }
      >
        <ExitReaderButton
          escapeKey
          fallbackHref={basePath}
          label="Back to details"
          className="grid h-9 w-9 place-items-center rounded-lg text-white/70 hover:bg-white/5 hover:text-white"
        >
          <X className="h-4 w-4" />
        </ExitReaderButton>
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold text-white">
            {incognito ? `Incognito · ${details.title}` : details.title}
          </h1>
          <div className="truncate text-[11px] text-white/50">
            Chapter {chapter} · {title}
          </div>
        </div>

        <div className="relative ml-auto flex items-center gap-1">
          <button
            onClick={() => setChapterListOpen((v) => !v)}
            aria-expanded={chapterListOpen}
            aria-label="Chapter list"
            className={`grid h-9 w-9 place-items-center rounded-lg transition ${
              chapterListOpen ? 'bg-white/10 text-white' : 'text-white/70 hover:bg-white/5'
            }`}
          >
            <List className="h-4 w-4" />
          </button>
          <div className="flex items-center gap-0.5 rounded-lg border border-white/10 px-0.5">
            <button
              onClick={zoomOut}
              disabled={zoom <= ZOOM_MIN}
              aria-label="Zoom out"
              className="grid h-8 w-8 place-items-center rounded-md text-white/70 transition hover:bg-white/5 disabled:opacity-30"
            >
              <ZoomOut className="h-4 w-4" />
            </button>
            <button
              onClick={() => setZoom(1)}
              className="w-11 text-center text-xs tabular-nums text-white/60 hover:text-white"
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              onClick={zoomIn}
              disabled={zoom >= ZOOM_MAX}
              aria-label="Zoom in"
              className="grid h-8 w-8 place-items-center rounded-md text-white/70 transition hover:bg-white/5 disabled:opacity-30"
            >
              <ZoomIn className="h-4 w-4" />
            </button>
          </div>
          <ReaderSettingsMenu />
          <ReaderPersonalTools
            source={sourceId}
            mangaId={details.id}
            chapterId={currentRecord?.id}
            page={page}
          />
          {preferredGroup && currentRecord?.scanlator !== preferredGroup && (
            <span role="status" className="text-xs text-white">
              {preferredGroup} unavailable; using{' '}
              {currentRecord?.scanlator || 'an available release'}.
            </span>
          )}

          {chapterListOpen && (
            <>
              <button
                type="button"
                tabIndex={-1}
                aria-label="Close chapter list"
                className="fixed inset-0 z-10"
                onClick={() => setChapterListOpen(false)}
              />
              <div className="absolute right-0 top-11 z-20 max-h-80 w-64 overflow-auto rounded-xl border border-white/10 bg-black/95 py-1.5 shadow-lg backdrop-blur-xl">
                {[...chapters].reverse().map((c) => (
                  <button
                    key={c.id}
                    onClick={() => {
                      setPreferredGroup(c.scanlator ?? '');
                      goToChapter(c.chapter_number, 1, c.id);
                      setChapterListOpen(false);
                    }}
                    className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs transition hover:bg-white/5 ${
                      c.chapter_number === chapter ? 'text-primary' : 'text-white/70'
                    }`}
                  >
                    <span className="truncate">
                      Ch. {c.chapter_number}
                      {c.name ? ` · ${c.name}` : ''}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {effectiveLayout === 'Long strip' ? (
        <LongStripViewer
          key={`${sourceId}:${details.id}:${preferredGroup}`}
          manga={manga}
          ready={chapters.length > 0}
          startChapter={chapter}
          startPage={page}
          getNextChapter={nextChapterAfter}
          getChapterTitle={(n) => chapterByNumber.get(n)?.name || `Chapter ${n}`}
          getChapterPageCount={(n) => chapterByNumber.get(n)?.page_count ?? 0}
          fetchPages={fetchPages}
          onPositionChange={(streamChapter, streamPage, streamTotal) => {
            if (streamChapter !== chapter) {
              setChapter(streamChapter);
              router.replace(`${basePath}/read?ch=${streamChapter}&page=${streamPage}`);
            }
            setPage(streamPage);
            if (streamTotal > 0) setObservedTotal({ chapter: streamChapter, total: streamTotal });
          }}
          zoom={zoom}
          pageGap={stripGap}
          autoAdvance={autoAdvance}
          onPageReady={onPageReady}
          getChapterIdentity={(number) => chapterByNumber.get(number)?.id ?? ''}
          releaseVersion={requestedChapterId}
          completionActions={completionActions}
        />
      ) : (
        <PagedViewer
          key={currentRecord?.id ?? chapter}
          manga={manga}
          page={page}
          totalPages={totalPages}
          pageUrls={pageUrls}
          pagesPerView={effectiveLayout === 'Single page' ? 1 : 2}
          readingDirection={readingDirection}
          onPositionChange={setPage}
          hasNextChapter={nextChapter !== null}
          nextChapterNumber={nextChapter ?? 0}
          onRequestNextChapter={() => nextChapter !== null && goToChapter(nextChapter, 1)}
          hasPrevChapter={prevChapter !== null}
          prevChapterNumber={prevChapter ?? 0}
          onRequestPrevChapter={() =>
            prevChapter !== null &&
            goToChapter(prevChapter, chapterByNumber.get(prevChapter)?.page_count || 1)
          }
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

      {showPageNumber && (
        <div className="pointer-events-none fixed bottom-16 right-5 z-30 rounded-full bg-black/60 px-3 py-1 text-[11px] font-medium tabular-nums text-white/80 backdrop-blur">
          {page} / {totalPages}
        </div>
      )}

      <div className="relative z-30 shrink-0">
        <ReaderProgressBar
          page={page}
          totalPages={totalPages}
          onSeek={(p) => setPage(Math.max(1, Math.min(totalPages, p)))}
        />
      </div>
    </div>
  );
}
