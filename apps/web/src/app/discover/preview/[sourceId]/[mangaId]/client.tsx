'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MangaDetails } from '@projekt-manga/types';
import {
  initiateDownload,
  getHistory,
  getMangaChapters,
  type HistoryEntry,
  type MangaChapterRecord,
} from '@projekt-manga/api-client';
import { toast } from '@/hooks/use-toast';
import { addSourceMangaToLibrary } from '@/lib/discover-actions';
import { useDuplicateCheckedAdd } from '@/components/discover/duplicate-manga-dialog';
import { fromSourceDetails, type Manga } from '@/lib/manga-data';
import { useMangaLibrary } from '@/lib/library-store';
import { MangaDetailLayout } from '@/components/manga-detail/detail-layout';
import { MangaActionBar } from '@/components/manga-detail/action-bar';
import { SourceActionBar } from '@/components/manga-detail/source-action-bar';
import { SourceChapterList } from '@/components/manga-detail/source-chapter-list';
import { SimilarTitles } from '@/components/manga-detail/similar-titles';
import { refreshDownloads } from '@/components/downloads/row-data';
import { useCurrentUser } from '@/lib/session-resource';
import { queryClient, queryKeys } from '@/lib/query-client';
import type { PublicUser } from '@projekt-manga/api-client';

/**
 * Detail page for a title reached through a source.
 *
 * Everything renders from the source payload the page was opened with, and keeps
 * rendering from it — adding to the library swaps the action row for the library one and
 * nothing else. It deliberately does not redirect, and deliberately does not re-fetch the
 * chapter list: the chapters on screen are the same chapters the library row was created
 * from, so reloading them would throw the list away and rebuild it identically.
 *
 * Nothing is written to the database just by looking. Reading, marking and downloading all
 * key off source + slug (`chapter.manga_id` and `history.manga_id` are both nullable), and
 * the actions that genuinely need a `manga_id` create the row lazily at that point.
 */
export function SourcePreviewClient({
  sourceId,
  details,
}: {
  sourceId: string;
  details: MangaDetails;
}) {
  const { user, loading } = useCurrentUser();
  if (loading)
    return (
      <p role="status" className="py-24 text-center text-sm text-muted-foreground">
        Loading your reading profile…
      </p>
    );
  return (
    <SourcePreviewContent
      key={`${user?.id ?? 'anonymous'}:${sourceId}:${details.id}`}
      sourceId={sourceId}
      details={details}
      owner={user?.id ?? 'anonymous'}
    />
  );
}

function SourcePreviewContent({
  sourceId,
  details,
  owner,
}: {
  sourceId: string;
  details: MangaDetails;
  owner: string;
}) {
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const requireCurrentProfile = useCallback(() => {
    if (
      !active.current ||
      (queryClient.getQueryData<PublicUser | null>(queryKeys.session)?.id ?? 'anonymous') !== owner
    )
      throw new Error('Reading profile changed. Retry in the current profile.');
  }, [owner]);
  const { manga: library, loading: libraryLoading, refresh } = useMangaLibrary();
  const [adding, setAdding] = useState(false);
  /** Read chapter ids for this slug, from history — works with or without a manga row. */
  const [historyReadIds, setHistoryReadIds] = useState<Set<string>>(new Set());
  const [chapterProgress, setChapterProgress] = useState<Map<string, HistoryEntry>>(new Map());
  /**
   * The library's own chapter rows, keyed by chapter URL, once this title has a row.
   *
   * History alone is not enough: it records only chapters that were actually *opened*.
   * Chapters marked read from the library — in bulk, or with "mark previous as read",
   * neither of which writes a history row — would look unread. The library row is the
   * authority on what has been read; history only adds where someone left off inside a
   * chapter.
   *
   * Keyed by URL because the two sides do not share an id: `Chapters.id` is the source's
   * own identifier and `MangaChapterRecord.id` is the database row's, while the URL is
   * the same string on both (it is what the row was created from).
   */
  const [libraryChapters, setLibraryChapters] = useState<Map<string, MangaChapterRecord>>(
    new Map(),
  );
  const [progressError, setProgressError] = useState(false);
  const [progressRetry, setProgressRetry] = useState(0);
  /** Id of the row backing this title, once one exists (shadow or library). */
  const [rowId, setRowId] = useState<string | null>(null);
  /** In the library right now. Held locally so add/remove flips the UI immediately rather
   * than waiting for the library list to come back. */
  const [inLibrary, setInLibrary] = useState<boolean | null>(null);
  // Adding goes through the duplicate check; this reports back whichever way the reader
  // resolves the dialog (add anyway, or migrate) so the page reflects it immediately.
  const { requestAdd, dialog: duplicateDialog } = useDuplicateCheckedAdd((id) => {
    setRowId(id);
    setInLibrary(true);
  });

  const sourceManga = useMemo(() => fromSourceDetails(details, sourceId), [details, sourceId]);
  const chapters = useMemo(() => details.chapters ?? [], [details.chapters]);
  const previewBase = `/discover/preview/${encodeURIComponent(sourceId)}/${encodeURIComponent(details.id)}`;

  const known = library.find((m) => m.source === sourceId && m.slug === details.slug);

  // The library list is the source of truth on load and whenever it refreshes; the local
  // flags only lead it between an action and the list catching up.
  useEffect(() => {
    if (libraryLoading) return;
    if (known) {
      setRowId(known.id);
      setInLibrary(known.inLibrary);
    } else {
      setInLibrary((current) => current ?? false);
    }
  }, [known, libraryLoading]);

  useEffect(() => {
    const controller = new AbortController();
    setProgressError(false);
    getHistory(controller.signal)
      .then((rows) => {
        if (controller.signal.aborted) return;
        const progress = new Map<string, HistoryEntry>();
        for (const row of rows) {
          if (row.source !== sourceId || row.manga_slug !== details.slug || !row.chapter_id)
            continue;
          const previous = progress.get(row.chapter_id);
          if (!previous || row.last_read > previous.last_read) progress.set(row.chapter_id, row);
        }
        setChapterProgress(progress);
        setHistoryReadIds(
          new Set([...progress].filter(([, row]) => row.is_read).map(([id]) => id)),
        );
      })
      .catch(() => {
        if (!controller.signal.aborted) setProgressError(true);
      });
    return () => controller.abort();
  }, [details.slug, sourceId, progressRetry]);

  /** Creates the backing row if it doesn't exist, outside the library. Deduped so two
   * actions firing at once don't race into two `addManga` calls. */
  const ensuring = useRef<Promise<string> | null>(null);
  const ensureRow = useCallback((): Promise<string> => {
    requireCurrentProfile();
    if (rowId) return Promise.resolve(rowId);
    if (!ensuring.current) {
      ensuring.current = addSourceMangaToLibrary(sourceId, details, details, false)
        .then((id) => {
          requireCurrentProfile();
          setRowId(id);
          return id;
        })
        .finally(() => {
          ensuring.current = null;
        });
    }
    return ensuring.current;
  }, [rowId, sourceId, details, requireCurrentProfile]);

  const add = () => {
    if (adding || inLibrary) return;
    setAdding(true);
    requestAdd(sourceId, details, details)
      .then((id) => {
        // null means the duplicate dialog opened instead; onDuplicateResolved below
        // handles the outcome, so there's nothing to report or update yet.
        if (id === null) return;
        toast({ description: `Added "${details.title}" to your library` });
        // Brings the library list in line for everything else on screen (the nav, Similar
        // titles). The page itself already reflects the change.
        void refresh();
      })
      .catch(() =>
        toast({
          description: `Couldn't add "${details.title}" — it may already be in your library.`,
        }),
      )
      .finally(() => setAdding(false));
  };

  const download = (chapter: { id: string; name?: string; chapter_number: number }) =>
    ensureRow()
      .then(() => {
        requireCurrentProfile();
        return initiateDownload({
          sourceId,
          mangaSlug: details.slug,
          mangaTitle: details.title,
          chapter: {
            id: chapter.id,
            name: chapter.name || undefined,
            chapter_number: chapter.chapter_number,
          },
        });
      })
      .then((result) => {
        refreshDownloads();
        return result;
      });

  useEffect(() => {
    // Only a title that actually has a row has library state to merge; a pure source
    // preview has nothing but history.
    if (!rowId) {
      setLibraryChapters(new Map());
      return;
    }
    const controller = new AbortController();
    getMangaChapters(rowId, details.slug, sourceId, controller.signal)
      .then((records) => {
        if (controller.signal.aborted) return;
        setLibraryChapters(new Map(records.filter((r) => r.url).map((r) => [r.url, r])));
      })
      // Deliberately silent: the source listing is still fully usable without the
      // library's read marks, and `progressError` already covers history failing.
      .catch(() => undefined);
    return () => controller.abort();
  }, [rowId, details.slug, sourceId, progressRetry]);

  /** A source chapter's library row, matched on URL. */
  const libraryChapterFor = useCallback(
    (chapter: { url: string }) => libraryChapters.get(chapter.url),
    [libraryChapters],
  );

  /**
   * Marks made here, before the library row and history catch up.
   *
   * The read set is derived from two fetched sources, so marking a chapter read cannot
   * just call a setter — the next render would recompute the old answer over it.
   * Recorded per chapter and applied last.
   */
  const [readOverrides, setReadOverrides] = useState<Map<string, boolean>>(new Map());

  /** Read according to any side: the library's mark, a history row, or a mark just made. */
  const readChapterIds = useMemo(() => {
    const ids = new Set(historyReadIds);
    for (const chapter of chapters) {
      if (libraryChapters.get(chapter.url)?.is_read) ids.add(chapter.id);
    }
    for (const [id, read] of readOverrides) {
      if (read) ids.add(id);
      else ids.delete(id);
    }
    return ids;
  }, [historyReadIds, libraryChapters, chapters, readOverrides]);

  /**
   * History, topped up from the library row.
   *
   * The chapter list shows "4 / 25" from this map, and history only has an entry for a
   * chapter that was opened. Progress saved only against the library row (e.g. by reading
   * on another device) would otherwise leave a part-read chapter looking untouched.
   */
  const mergedChapterProgress = useMemo(() => {
    if (libraryChapters.size === 0) return chapterProgress;
    const merged = new Map(chapterProgress);
    for (const chapter of chapters) {
      const row = libraryChapters.get(chapter.url);
      if (!row) continue;
      const existing = merged.get(chapter.id);
      // Whichever side got further; neither should ever move a reader backwards.
      const lastPage = Math.max(existing?.last_page_read ?? 0, row.last_page_read ?? 0);
      if (lastPage === 0 && !row.is_read) continue;
      merged.set(chapter.id, {
        ...(existing ?? {
          id: row.id,
          source: sourceId,
          manga_slug: details.slug,
          chapter_id: row.id,
          pages_read: 0,
          time_read: 0,
          last_read: row.updated_at ?? '',
          read_at: row.updated_at ?? '',
        }),
        last_page_read: lastPage,
        page_count: existing?.page_count || (row.page_count ?? 0),
        is_read: existing?.is_read || row.is_read,
      } as HistoryEntry);
    }
    return merged;
  }, [chapterProgress, libraryChapters, chapters, sourceId, details.slug]);

  /** The chapter list hands back the complete set for the chapters it rendered. */
  const applyReadChange = useCallback(
    (next: Set<string>) => {
      setReadOverrides(new Map(chapters.map((chapter) => [chapter.id, next.has(chapter.id)])));
    },
    [chapters],
  );

  // Once in the library, chapters open in the canonical reader (progress keys off the
  // manga row); before that, the preview reader, which keys off source + slug.
  const readerHref = (chapterNumber: number) => {
    const chapter = chapters.find((entry) => entry.chapter_number === chapterNumber);
    const progress = chapter ? chapterProgress.get(chapter.id) : undefined;
    const page =
      chapter && progress && !readChapterIds.has(chapter.id) && progress.last_page_read > 0
        ? `&page=${progress.last_page_read}`
        : '';
    return inLibrary && rowId
      ? `/reader/${rowId}?ch=${chapterNumber}${page}`
      : `${previewBase}/read?ch=${chapterNumber}${page}`;
  };

  const ascending = [...chapters].sort((a, b) => a.chapter_number - b.chapter_number);
  const firstChapter = ascending[0];
  const resumeChapter = [...chapters]
    .filter((chapter) => {
      const progress = chapterProgress.get(chapter.id);
      return progress && !readChapterIds.has(chapter.id) && progress.last_page_read > 0;
    })
    .sort((a, b) =>
      (chapterProgress.get(b.id)?.last_read ?? '').localeCompare(
        chapterProgress.get(a.id)?.last_read ?? '',
      ),
    )[0];

  /** The source chapter list in the shape the library action bar expects, so its download
   * menu can work off what's already loaded instead of re-fetching. */
  const chapterRecords: MangaChapterRecord[] = useMemo(
    () =>
      chapters.map((c) => ({
        id: c.id,
        name: c.name || null,
        url: c.url,
        scanlator: c.scanlator ?? null,
        chapter_number: c.chapter_number,
        is_read: readChapterIds.has(c.id),
        is_bookmark: libraryChapterFor(c)?.is_bookmark ?? false,
        // Whichever side got further. The two can disagree after reading on another
        // device, and the further position is the one that is not a regression.
        last_page_read: Math.max(
          chapterProgress.get(c.id)?.last_page_read ?? 0,
          libraryChapterFor(c)?.last_page_read ?? 0,
        ),
        page_count:
          c.page_count && c.page_count > 0
            ? c.page_count
            : (libraryChapterFor(c)?.page_count ?? chapterProgress.get(c.id)?.page_count ?? null),
        fetched_at: c.fetched_at ?? null,
        release_date: c.release_date ?? null,
        created_at: c.release_date ?? '',
      })) as MangaChapterRecord[],
    [chapters, readChapterIds, chapterProgress, libraryChapterFor],
  );

  /** The library action bar renders from a `Manga`; before the list refreshes we already
   * know enough to build one, so it doesn't have to wait on a fetch. */
  const libraryManga: Manga | null =
    rowId && inLibrary
      ? { ...(known ?? sourceManga), id: rowId, inLibrary: true, chapters: chapters.length }
      : null;

  return (
    <MangaDetailLayout
      manga={known ?? sourceManga}
      backHref="/discover"
      backLabel="Discover"
      actions={
        libraryManga ? (
          <MangaActionBar
            manga={libraryManga}
            knownChapters={chapterRecords}
            onRemoved={() => {
              setInLibrary(false);
              void refresh();
            }}
          />
        ) : (
          <SourceActionBar
            mangaId={rowId}
            sourceId={sourceId}
            mangaSlug={details.slug}
            sourceUrl={details.url}
            title={details.title}
            chapters={chapters}
            readChapterIds={readChapterIds}
            firstChapterHref={
              resumeChapter
                ? readerHref(resumeChapter.chapter_number)
                : firstChapter
                  ? readerHref(firstChapter.chapter_number)
                  : null
            }
            resuming={Boolean(resumeChapter)}
            onAdd={add}
            adding={adding}
            checking={libraryLoading && inLibrary === null}
            ensureRow={ensureRow}
          />
        )
      }
    >
      {progressError && (
        <div
          role="alert"
          className="mt-6 rounded-lg border border-destructive/40 p-3 text-xs text-foreground"
        >
          Saved chapter progress is unavailable. Read indicators may be incomplete.
          <button
            type="button"
            onClick={() => setProgressRetry((value) => value + 1)}
            className="ml-2 text-primary hover:underline"
          >
            Try again
          </button>
        </div>
      )}
      <SourceChapterList
        chapters={chapters}
        mangaSlug={details.slug}
        sourceMangaId={details.id}
        sourceId={sourceId}
        mangaTitle={details.title}
        thumbnailUrl={details.thumbnail_url}
        readChapterIds={readChapterIds}
        chapterProgress={mergedChapterProgress}
        readerHref={readerHref}
        onDownload={download}
        onReadChange={applyReadChange}
      />
      {libraryManga && <SimilarTitles manga={libraryManga} />}
      {duplicateDialog}
    </MangaDetailLayout>
  );
}
