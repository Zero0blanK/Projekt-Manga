'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { MangaDetails } from '@projekt-manga/types';
import {
  getSourceChapterPages,
  buildImageProxyUrl,
  markChapterAsRead,
} from '@projekt-manga/api-client';
import { invalidateSavedReadingProgress } from '@/lib/query-client';
import { fromSourceDetails } from '@/lib/manga-data';
import { ReaderColorFilterContext, useReaderSettings } from '@/lib/reader-settings';
import { useWakeLock } from '@/lib/use-wake-lock';
import { PagedViewer } from '@/components/reader/paged-viewer';
import { LongStripViewer } from '@/components/reader/long-strip-viewer';
import { ReaderProgressBar } from '@/components/reader/reader-progress-bar';
import { ReaderSettingsMenu } from '@/components/reader/reader-settings-menu';
import { PageImageActions } from '@/components/reader/page-image-actions';
import { usePagePrefetch } from '@/components/reader/use-page-prefetch';
import { useChapterPages, useLoadedPage } from '@/components/reader/use-chapter-pages';
import { useAutoMarkRead, useReaderProgress } from '@/components/reader/use-reader-progress';
import { ExitReaderButton } from '@/components/reader/exit-reader-button';
import { X, ZoomIn, ZoomOut, List } from 'lucide-react';
import { useProfilePreference } from '@/lib/profile-preferences';
import { parseChapterParam, parsePreferredGroup } from '@/lib/reader-preferences';
import { ReaderPersonalTools } from '@/components/reader/reader-personal-tools';
import { ReaderTintOverlay } from '@/components/reader/reader-tint';
import { useSourceIncognito } from '@/lib/incognito';
import { useAutoAdvanceCountdown } from '@/lib/auto-advance';
import { useReaderZoom, ZOOM_MAX, ZOOM_MIN } from '@/lib/reader-zoom';
import { useReaderInput } from '@/components/reader/use-reader-input';
import { ReaderShortcuts } from '@/components/reader/reader-shortcuts';
import { ReaderContextMenu } from '@/components/reader/reader-context-menu';

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
    colorFilter,
    tint,
    tintStrength,
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
  const { zoom, setZoom, zoomIn, zoomOut, zoomReset } = useReaderZoom();
  const [chapterListOpen, setChapterListOpen] = useState(false);
  const [observedTotal, setObservedTotal] = useState<{ chapter: number; total: number } | null>(
    null,
  );

  const currentRecord = chapterByNumber.get(chapter);
  const invalidChapterId =
    requestedChapterId !== null && !chapters.some((record) => record.id === requestedChapterId);
  const { imageReady, markPageLoaded } = useLoadedPage(currentRecord?.id, page);
  const onPageReady = (number: number, p: number) => {
    const record = chapterByNumber.get(number);
    if (record) markPageLoaded(record.id, p);
  };

  // Zoom is deliberately left alone here — see the same note in the library reader
  // (app/reader/[id]/client.tsx) for why resetting it on every chapter change breaks
  // Long Strip mode's auto-advance-while-scrolling.
  const { pageUrls, pagesError, pagesFor, retryPages } = useChapterPages({
    chapter,
    record: currentRecord,
    enabled: chapters.length > 0 && effectiveLayout !== 'Long strip' && !invalidChapterId,
    load: async (record) => {
      const result = await getSourceChapterPages(sourceId, record.id, { mangaSlug: details.slug });
      return result.items
        .sort((a, b) => a.index - b.index)
        .map((p) => (p.image_url ? buildImageProxyUrl(p.image_url, sourceId) : ''))
        .filter(Boolean);
    },
  });
  const fetchPages = useCallback(
    (chapterNumber: number): Promise<string[]> => {
      const record = chapterByNumber.get(chapterNumber);
      return record ? pagesFor(record) : Promise.resolve([]);
    },
    [chapterByNumber, pagesFor],
  );
  const knownTotal =
    (observedTotal?.chapter === chapter ? observedTotal.total : 0) ||
    pageUrls.length ||
    currentRecord?.page_count ||
    0;
  const totalPages = knownTotal || 1;

  usePagePrefetch(pageUrls, page, pagePrefetchAhead);

  /* ------------------------------------------------- progress + history (no manga row) */

  const incognito = useSourceIncognito(sourceId);
  const canSave = !incognito && !!currentRecord && knownTotal > 0 && imageReady;
  // chapter.manga_id and history.manga_id are both nullable, so these persist against the
  // slug alone. The title and cover are sent because there's no manga row to join to.
  const { flushProgress: flush } = useReaderProgress(
    {
      source: sourceId,
      mangaSlug: details.slug,
      history: {
        source_manga_id: details.id,
        title: details.title,
        thumbnail_url: details.thumbnail_url || undefined,
      },
    },
    canSave && !invalidChapterId
      ? {
          sourceChapterKey: currentRecord.id,
          page: Math.min(page, knownTotal),
          pageCount: knownTotal,
          body: {
            source: sourceId,
            chapter_number: currentRecord.chapter_number,
            name: currentRecord.name,
            url: currentRecord.url,
            page_count: knownTotal,
          },
        }
      : null,
  );

  // Only the URL is authoritative here; streamed chapter updates have their own path.
  const addressState = useRef({ chapter, flush });
  addressState.current = { chapter, flush };
  useEffect(() => {
    if (addressState.current.chapter !== requestedChapter) addressState.current.flush();
    setChapter(requestedChapter);
    setPage(requestedPage ?? 1);
  }, [requestedChapter, requestedPage]);

  const finishedRecord = canSave && !invalidChapterId && page >= knownTotal ? currentRecord : null;
  useAutoMarkRead(finishedRecord?.id ?? null, () => {
    const record = finishedRecord!;
    return markChapterAsRead(details.slug, record.id, {
      source: sourceId,
      chapter_number: record.chapter_number,
      name: record.name,
      url: record.url,
      page_count: knownTotal,
    }).then(invalidateSavedReadingProgress);
  });

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

  // Settings › Reader › Keyboard. Page turning belongs to the viewers.
  useReaderInput({
    zoomIn,
    zoomOut,
    zoomReset,
    chapterList: () => setChapterListOpen((v) => !v),
    nextChapter: () => {
      if (nextChapter === null) return false;
      goToChapter(nextChapter, 1);
    },
    prevChapter: () => {
      if (prevChapter === null) return false;
      goToChapter(prevChapter, chapterByNumber.get(prevChapter)?.page_count || 1);
    },
  });

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
    <ReaderColorFilterContext.Provider value={colorFilter}>
      <div className="fixed inset-0 z-50 flex flex-col" style={{ background }}>
        {/* Settings > Reader > Brightness — see the library reader for the rationale. */}
        {brightness < 100 && (
          <div
            aria-hidden
            className="pointer-events-none fixed inset-0 z-20 bg-black"
            style={{ opacity: (100 - brightness) / 100 }}
          />
        )}
        <ReaderTintOverlay tint={tint} strength={tintStrength} />
        <ReaderShortcuts />

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
            <div className="truncate text-xs text-white/50">
              Chapter {chapter} · {title}
            </div>
          </div>

          <div className="relative ml-auto flex items-center gap-1">
            <button
              type="button"
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
                type="button"
                onClick={zoomOut}
                disabled={zoom <= ZOOM_MIN}
                aria-label="Zoom out"
                className="grid h-8 w-8 place-items-center rounded-md text-white/70 transition hover:bg-white/5 disabled:opacity-30"
              >
                <ZoomOut className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => setZoom(1)}
                className="w-11 text-center text-xs tabular-nums text-white/60 hover:text-white"
              >
                {Math.round(zoom * 100)}%
              </button>
              <button
                type="button"
                onClick={zoomIn}
                disabled={zoom >= ZOOM_MAX}
                aria-label="Zoom in"
                className="grid h-8 w-8 place-items-center rounded-md text-white/70 transition hover:bg-white/5 disabled:opacity-30"
              >
                <ZoomIn className="h-4 w-4" />
              </button>
            </div>
            <PageImageActions
              imageUrl={pageUrls[page - 1]}
              mangaTitle={manga.title}
              chapter={chapter}
              page={page}
            />
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
                <div
                  data-reader-keys-ignore
                  className="absolute right-0 top-11 z-20 max-h-80 w-64 overflow-auto rounded-xl border border-white/10 bg-black/95 py-1.5 shadow-lg backdrop-blur-xl"
                >
                  {[...chapters].reverse().map((c) => (
                    <button
                      type="button"
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

        <ReaderContextMenu
          pageUrls={pageUrls}
          page={page}
          mangaTitle={manga.title}
          chapter={chapter}
        >
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
                if (streamTotal > 0)
                  setObservedTotal({ chapter: streamChapter, total: streamTotal });
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
              onZoomChange={setZoom}
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
        </ReaderContextMenu>

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
    </ReaderColorFilterContext.Provider>
  );
}
