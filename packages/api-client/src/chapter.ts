import type { Chapters } from '@projekt-manga/types';
import { request } from './client.js';
import { hasLocalDataBridge, localInvoke } from './runtime.js';
import { addHistory } from './history.js';
import type { MangaChapterRecord, MangaWithDetails } from './manga.js';

export type ChapterBulkPayload = Partial<Chapters> & { source?: string };
export type ChapterProgressMeta = Partial<Chapters> & { source?: string };

export interface UpdateResult {
  count: number;
}

export interface BulkMarkResult {
  count: number;
  failed_chapter_ids: string[];
}

export interface ChapterProgress {
  last_page_read: number;
  is_read: boolean;
}

export interface ChapterReadStatus {
  is_read: boolean;
}

export interface RecentChapter extends MangaChapterRecord {
  manga: {
    id: string;
    slug: string;
    title: string;
    thumbnail_url: string;
  };
}

const encode = (value: string) => encodeURIComponent(value);

// The recent-chapters feed remains HTTP-only; bulk marks use local state on desktop.

export const markChapterAsRead = (
  mangaSlug: string,
  chapterId: string,
  chapterMeta?: ChapterProgressMeta,
) => {
  if (hasLocalDataBridge()) {
    // chapterMeta is forwarded, not dropped: the desktop's local database enforces a
    // foreign key from read state to the chapter row, so marking a chapter it has never
    // seeded needs enough catalog data to stand that row up first — the same thing the
    // server does with ensureChapterExists on this path.
    return localInvoke<null>('chapter', 'markRead', {
      chapterId,
      isRead: true,
      chapter: chapterMeta,
    }).then(() => ({ count: 1 }));
  }
  return request<UpdateResult>(`/chapter/${encode(mangaSlug)}/${encode(chapterId)}/mark-read`, {
    method: 'POST',
    body: chapterMeta,
  });
};

export const markChapterAsUnread = (
  mangaSlug: string,
  chapterId: string,
  chapterMeta?: ChapterProgressMeta,
) => {
  if (hasLocalDataBridge()) {
    return localInvoke<null>('chapter', 'markRead', {
      chapterId,
      isRead: false,
      chapter: chapterMeta,
    }).then(() => ({ count: 1 }));
  }
  return request<UpdateResult>(`/chapter/${encode(mangaSlug)}/${encode(chapterId)}/mark-unread`, {
    method: 'POST',
    body: chapterMeta,
  });
};

export const markChapterByLastPage = (
  mangaSlug: string,
  chapterId: string,
  lastPageRead: number,
  chapterMeta?: ChapterProgressMeta,
) => {
  if (hasLocalDataBridge()) {
    return localInvoke<null>('chapter', 'updateProgress', {
      chapterId,
      lastPageRead,
      chapter: chapterMeta,
    }).then(() => ({ count: 1 }));
  }
  return request<UpdateResult>(
    `/chapter/${encode(mangaSlug)}/${encode(chapterId)}/${lastPageRead}/mark-by-page`,
    { method: 'POST', body: chapterMeta },
  );
};

/** Manga-level fields recorded on the history rows a bulk mark writes. Only needed for
 * titles that have no library row to join a title/cover from. */
export interface BulkMarkMangaMeta {
  /** Used by desktop's local chapter/history rows; ignored by the server schema. */
  manga_id?: string;
  source_manga_id?: string;
  title?: string;
  thumbnail_url?: string;
}

const markChaptersBulk = async (
  mangaSlug: string,
  chapters: ChapterBulkPayload[],
  isRead: boolean,
  manga?: BulkMarkMangaMeta,
): Promise<BulkMarkResult> => {
  if (!hasLocalDataBridge()) {
    return request<BulkMarkResult>(
      `/chapter/${encode(mangaSlug)}/bulk-mark-${isRead ? 'read' : 'unread'}`,
      { method: 'POST', body: { chapters, ...manga } },
    );
  }

  const results = await Promise.allSettled(
    chapters.map(async (chapter) => {
      if (!chapter.id) throw new Error('Chapter ID is required');
      await localInvoke<null>('chapter', 'markRead', {
        chapterId: chapter.id,
        isRead,
        chapter: { ...chapter, manga_id: manga?.manga_id },
      });
      if (chapter.source) {
        await addHistory({
          source: chapter.source,
          manga_slug: mangaSlug,
          manga_id: manga?.manga_id,
          source_manga_id: manga?.source_manga_id,
          title: manga?.title,
          thumbnail_url: manga?.thumbnail_url,
          chapter_id: chapter.id,
          pages_read: isRead ? (chapter.page_count ?? 0) : 0,
        });
      }
    }),
  );
  return {
    count: results.filter((result) => result.status === 'fulfilled').length,
    failed_chapter_ids: chapters.flatMap((chapter, index) =>
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

export const addChapterAsHistory = (chapterData: Chapters) =>
  request<MangaChapterRecord>('/chapter/add-history', { method: 'POST', body: chapterData });

export const getChapterProgressById = (chapterId: string, signal?: AbortSignal) =>
  request<ChapterProgress | null>(`/chapter/${encode(chapterId)}/progress`, { signal });

/** Returns the 10 most recently fetched chapters across every manga in the library. */
export const getChapterFetchDate = (signal?: AbortSignal) =>
  request<RecentChapter[]>('/chapter/recent', { signal });

export const getChapterReadStatusById = (chapterId: string, signal?: AbortSignal) =>
  request<ChapterReadStatus | null>(`/chapter/status/${encode(chapterId)}`, { signal });

export const getChapter = (mangaSlug: string, signal?: AbortSignal, source?: string) =>
  request<MangaChapterRecord[]>(`/chapter/${encode(mangaSlug)}`, { signal, query: { source } });

/** The desktop reader writes chapter state locally, so its chapter list must read that
 * same state instead of asking the server for an older snapshot. */
export const getMangaChapters = async (
  mangaId: string,
  mangaSlug: string,
  source: string,
  signal?: AbortSignal,
): Promise<MangaChapterRecord[]> => {
  if (hasLocalDataBridge()) {
    const details = await localInvoke<MangaWithDetails | null>('manga', 'getDetails', { mangaId });
    if (details) return details.chapters;
  }
  return getChapter(mangaSlug, signal, source);
};
