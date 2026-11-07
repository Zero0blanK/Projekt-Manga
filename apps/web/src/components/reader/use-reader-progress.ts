'use client';

import { useCallback, useEffect, useRef } from 'react';
import {
  addHistory,
  buildApiUrl,
  markChapterByLastPage,
  usesLocalFirstDataSync,
} from '@projekt-manga/api-client';
import { isSourceIncognito, useSourceIncognito } from '@/lib/incognito';
import { invalidateSavedReadingProgress } from '@/lib/query-client';
import { queueReaderProgressBeacons } from '@/lib/reader-progress-beacon';
import { reportError } from '@/lib/report-error';
import { useReadingClock } from '@/lib/use-reading-clock';

const SAVE_DEBOUNCE_MS = 800;
const SAVE_FAILED = "Your reading progress isn't being saved.";

type ProgressBody = Parameters<typeof markChapterByLastPage>[3];
type HistoryFields = Omit<
  Parameters<typeof addHistory>[0],
  'source' | 'manga_slug' | 'source_chapter_key' | 'pages_read' | 'time_read'
>;

/** Where the reader is, once that's worth saving. Progress names the chapter by the source's
 * key, like every chapter write. */
export type ReaderPosition = {
  sourceChapterKey: string;
  page: number;
  pageCount: number;
  body: ProgressBody;
};

/** The title being read: a library entry, or a source title with no manga row, whose history
 * has to carry its own name and cover. */
export type ReaderProgressTarget = {
  source: string;
  mangaSlug: string;
  history: HistoryFields;
};

/**
 * Saves where the reader is: debounced while paging, and at once on leaving.
 *
 * `position` is null until there's something real to save, so a page total that hasn't
 * resolved can never write a meaningless "page 1 of 1" over saved progress.
 *
 * A write that fails is kept and sent with the next one, along with its reading time.
 * Returns `flushProgress`, for moving to another chapter.
 */
export function useReaderProgress(
  target: ReaderProgressTarget,
  position: ReaderPosition | null,
): { flushProgress: (useBeacon?: boolean) => void } {
  const incognito = useSourceIncognito(target.source);
  const targetRef = useRef(target);
  targetRef.current = target;

  // Kept in a ref so the flush paths (debounce timer, unmount, tab close) always send the
  // newest value rather than a stale closure's.
  const pending = useRef<ReaderPosition | null>(null);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  /** Reading time from a write that failed, added to the next one. */
  const unsavedTime = useRef(0);
  const takeElapsed = useReadingClock();
  useEffect(() => {
    takeElapsed();
  }, [incognito, takeElapsed]);

  const flushProgress = useCallback(
    (useBeacon = false) => {
      const { source, mangaSlug, history: fields } = targetRef.current;
      if (isSourceIncognito(source)) {
        pending.current = null;
        return;
      }
      const position = pending.current;
      if (!position) return;
      pending.current = null;
      if (flushTimer.current) {
        clearTimeout(flushTimer.current);
        flushTimer.current = null;
      }

      const { sourceChapterKey, page, body } = position;
      const path = `/chapter/${encodeURIComponent(mangaSlug)}/${encodeURIComponent(sourceChapterKey)}/${page}/mark-by-page`;
      // Time since the last flush, not a running total — the server adds it to what it
      // already has. Reading it here means it's taken exactly once per flush.
      const time_read = takeElapsed() + unsavedTime.current;
      unsavedTime.current = 0;
      const history = {
        ...fields,
        source,
        manga_slug: mangaSlug,
        source_chapter_key: sourceChapterKey,
        pages_read: page,
        time_read,
      };

      // Deduped inside reportError, deliberately: this fires on every page turn, and a toast
      // per page would be unusable. Losing your place silently is the worse of the two.
      const saveProgress = () =>
        markChapterByLastPage(mangaSlug, sourceChapterKey, page, body)
          .then(invalidateSavedReadingProgress)
          .catch((error) => {
            // A newer position, if there is one, already supersedes this.
            pending.current ??= position;
            reportError(error, SAVE_FAILED);
          });
      const saveHistory = () =>
        addHistory(history)
          .then(invalidateSavedReadingProgress)
          .catch((error) => {
            unsavedTime.current += time_read;
            reportError(error, SAVE_FAILED);
          });

      // On tab close/hide a normal fetch is often killed mid-flight; sendBeacon is the
      // one transport the browser promises to finish.
      if (useBeacon && !usesLocalFirstDataSync()) {
        const queued = queueReaderProgressBeacons(
          buildApiUrl(path),
          body,
          buildApiUrl('/history/add'),
          history,
        );
        if (queued?.progressQueued || queued?.historyQueued) invalidateSavedReadingProgress();
        if (queued?.progressQueued && queued.historyQueued) return;
        if (queued?.progressQueued) {
          void saveHistory();
          return;
        }
        if (queued?.historyQueued) {
          void saveProgress();
          return;
        }
      }

      saveQueue.current = saveQueue.current.then(async () => {
        if (isSourceIncognito(source)) return;
        await Promise.all([saveProgress(), saveHistory()]);
      });
    },
    [takeElapsed],
  );

  const positionRef = useRef(position);
  positionRef.current = position;
  const positionKey = position
    ? `${position.sourceChapterKey}\0${position.page}\0${position.pageCount}`
    : null;

  // Paging quickly through a chapter shouldn't fire a write per page.
  useEffect(() => {
    if (!positionRef.current || incognito) return;
    pending.current = positionRef.current;
    if (flushTimer.current) clearTimeout(flushTimer.current);
    flushTimer.current = setTimeout(() => flushProgress(), SAVE_DEBOUNCE_MS);
    return () => {
      if (flushTimer.current) clearTimeout(flushTimer.current);
    };
  }, [positionKey, incognito, flushProgress]);

  // Save immediately when the reader leaves — closing/hiding the tab, or unmounting.
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

  return { flushProgress };
}

/** Marks a chapter read once it's finished, without the reader doing it by hand. `chapterId`
 * is null until they've reached the end; each chapter fires once a session, so scrolling back
 * and forth over the last page doesn't repeat it, and a failure may try again. */
export function useAutoMarkRead(chapterId: string | null, mark: () => Promise<unknown>) {
  const sent = useRef(new Set<string>());
  const markRef = useRef(mark);
  markRef.current = mark;

  useEffect(() => {
    if (!chapterId || sent.current.has(chapterId)) return;
    sent.current.add(chapterId);
    markRef.current().catch(() => sent.current.delete(chapterId));
  }, [chapterId]);
}
