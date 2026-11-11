import type { Chapters } from '@projekt-manga/types';
import { request } from './client.js';
import { localInvoke, usesLocalFirstData } from './runtime.js';
import { addHistory } from './history.js';
import { awaitProgressWrite } from './progressHold.js';
import type { MangaChapterRecord, MangaWithDetails } from './manga.js';
import type {
  ChapterBulkPayload,
  ChapterProgressMeta,
  UpdateResult,
  BulkMarkResult,
  ChapterProgress,
  ChapterReadStatus,
  RecentChapter,
  BulkMarkMangaMeta,
} from '@projekt-manga/types';
export type {
  ChapterBulkPayload,
  ChapterProgressMeta,
  UpdateResult,
  BulkMarkResult,
  ChapterProgress,
  ChapterReadStatus,
  RecentChapter,
  BulkMarkMangaMeta,
} from '@projekt-manga/types';

const encode = (value: string) => encodeURIComponent(value);

// The recent-chapters feed remains HTTP-only; bulk marks use local state on desktop.

/** What the desktop needs to find — or stand up — its own row for the chapter: the
 * source's key within the title, plus enough catalog data to create the row (its local
 * database enforces a foreign key from read state to the chapter, as the server does). */
const localChapterStub = (
  mangaSlug: string,
  sourceChapterKey: string,
  chapterMeta: ChapterProgressMeta & { manga_id?: string },
) => ({ ...chapterMeta, manga_slug: mangaSlug, source_chapter_key: sourceChapterKey });

export const markChapterAsRead = async (
  mangaSlug: string,
  sourceChapterKey: string,
  chapterMeta: ChapterProgressMeta,
) => {
  if (await usesLocalFirstData()) {
    return localInvoke<null>('chapter', 'markRead', {
      isRead: true,
      chapter: localChapterStub(mangaSlug, sourceChapterKey, chapterMeta),
    }).then(() => ({ count: 1 }));
  }
  // Held while a restore runs (progressHold.ts); a newer save for the chapter replaces it.
  if (!(await awaitProgressWrite(`chapter:${mangaSlug}:${sourceChapterKey}`))) return { count: 0 };
  return request<UpdateResult>(
    `/chapter/${encode(mangaSlug)}/${encode(sourceChapterKey)}/mark-read`,
    { method: 'POST', body: chapterMeta },
  );
};

export const markChapterAsUnread = async (
  mangaSlug: string,
  sourceChapterKey: string,
  chapterMeta: ChapterProgressMeta,
) => {
  if (await usesLocalFirstData()) {
    return localInvoke<null>('chapter', 'markRead', {
      isRead: false,
      chapter: localChapterStub(mangaSlug, sourceChapterKey, chapterMeta),
    }).then(() => ({ count: 1 }));
  }
  if (!(await awaitProgressWrite(`chapter:${mangaSlug}:${sourceChapterKey}`))) return { count: 0 };
  return request<UpdateResult>(
    `/chapter/${encode(mangaSlug)}/${encode(sourceChapterKey)}/mark-unread`,
    { method: 'POST', body: chapterMeta },
  );
};

export const markChapterByLastPage = async (
  mangaSlug: string,
  sourceChapterKey: string,
  lastPageRead: number,
  chapterMeta: ChapterProgressMeta,
) => {
  if (await usesLocalFirstData()) {
    return localInvoke<null>('chapter', 'updateProgress', {
      lastPageRead,
      chapter: localChapterStub(mangaSlug, sourceChapterKey, chapterMeta),
    }).then(() => ({ count: 1 }));
  }
  if (!(await awaitProgressWrite(`chapter:${mangaSlug}:${sourceChapterKey}`))) return { count: 0 };
  return request<UpdateResult>(
    `/chapter/${encode(mangaSlug)}/${encode(sourceChapterKey)}/${lastPageRead}/mark-by-page`,
    { method: 'POST', body: chapterMeta },
  );
};

const markChaptersBulk = async (
  mangaSlug: string,
  chapters: ChapterBulkPayload[],
  isRead: boolean,
  manga?: BulkMarkMangaMeta,
): Promise<BulkMarkResult> => {
  if (!(await usesLocalFirstData())) {
    // A bulk mark is one deliberate action, so it waits but is never replaced.
    await awaitProgressWrite(`bulk:${crypto.randomUUID()}`);
    return request<BulkMarkResult>(
      `/chapter/${encode(mangaSlug)}/bulk-mark-${isRead ? 'read' : 'unread'}`,
      { method: 'POST', body: { chapters, ...manga } },
    );
  }

  const results = await Promise.allSettled(
    chapters.map(async (chapter) => {
      if (!chapter.id) throw new Error('Chapter ID is required');
      if (!chapter.source) throw new Error('Chapter source is required');
      await localInvoke<null>('chapter', 'markRead', {
        isRead,
        chapter: localChapterStub(mangaSlug, chapter.id, {
          ...chapter,
          source: chapter.source,
          manga_id: manga?.manga_id,
        }),
      });
      if (chapter.source) {
        await addHistory({
          source: chapter.source,
          manga_slug: mangaSlug,
          manga_id: manga?.manga_id,
          source_manga_id: manga?.source_manga_id,
          title: manga?.title,
          thumbnail_url: manga?.thumbnail_url,
          source_chapter_key: chapter.id,
          pages_read: isRead ? (chapter.page_count ?? 0) : 0,
        });
      }
    }),
  );
  return {
    count: results.filter((result) => result.status === 'fulfilled').length,
    failed_source_chapter_keys: chapters.flatMap((chapter, index) =>
      results[index]?.status === 'rejected' && chapter.id ? [chapter.id] : [],
    ),
  };
};

export const markPreviousChaptersAsRead = (
  mangaSlug: string,
  chapters: ChapterBulkPayload[],
  manga?: BulkMarkMangaMeta,
) => markChaptersBulk(mangaSlug, chapters, true, manga);

export const markPreviousChaptersAsUnread = (
  mangaSlug: string,
  chapters: ChapterBulkPayload[],
  manga?: BulkMarkMangaMeta,
) => markChaptersBulk(mangaSlug, chapters, false, manga);

export const addChapterAsHistory = (
  chapterData: Chapters & { source: string; manga_slug: string },
) => request<MangaChapterRecord>('/chapter/add-history', { method: 'POST', body: chapterData });

export const getChapterProgressById = (chapterId: string, signal?: AbortSignal) =>
  request<ChapterProgress | null>(`/chapter/${encode(chapterId)}/progress`, { signal });

/** Returns the 10 most recently fetched chapters across every manga in the library. */
export const getChapterFetchDate = (signal?: AbortSignal) =>
  request<RecentChapter[]>('/chapter/recent', { signal });

export const getChapterReadStatusById = (chapterId: string, signal?: AbortSignal) =>
  request<ChapterReadStatus | null>(`/chapter/status/${encode(chapterId)}`, { signal });

export const getChapter = (mangaSlug: string, signal?: AbortSignal, source?: string) =>
  request<MangaChapterRecord[]>(`/chapter/${encode(mangaSlug)}`, { signal, query: { source } });

/** A signed-in desktop reader writes chapter state locally, so its chapter list must read that
 * same state instead of asking the server for an older snapshot. */
export const getMangaChapters = async (
  mangaId: string,
  mangaSlug: string,
  source: string,
  signal?: AbortSignal,
): Promise<MangaChapterRecord[]> => {
  if (await usesLocalFirstData()) {
    const details = await localInvoke<MangaWithDetails | null>('manga', 'getDetails', { mangaId });
    if (details) return details.chapters;
  }
  return getChapter(mangaSlug, signal, source);
};
