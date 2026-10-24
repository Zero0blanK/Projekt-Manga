import type { Chapters } from '@projekt-manga/types';
import chapterRepository from '../repositories/chapter.repository.js';
import historyRepository from '../repositories/history.repository.js';
import mangaRepository from '../repositories/manga.repository.js';
import userChapterStateRepository from '../repositories/userChapterState.repository.js';
import trackerService from './tracker.service.js';
import { MangaNotFoundError, PrismaError, rethrowKnownOrWrap } from '../utils/customErrors.js';

type ChapterBulkPayload = Partial<Chapters> & { source?: string };
type ChapterProgressPayload = Partial<Chapters> & { source?: string };
type BulkMangaMeta = { source_manga_id?: string; title?: string; thumbnail_url?: string };

const ensureChapterExists = async (chapter_id: string, chapter_data?: Partial<Chapters>) => {
  await chapterRepository.ensureChapterForProgress({
    id: chapter_id,
    url: chapter_data?.url || '',
    name: chapter_data?.name || '',
    scanlator: chapter_data?.scanlator || '',
    chapter_number: chapter_data?.chapter_number || 0,
    release_date: chapter_data?.release_date || new Date().toISOString(),
    last_page_read: chapter_data?.last_page_read || 0,
    page_count: chapter_data?.page_count || 0,
  } as Chapters);

  const chapterNumber = chapter_data?.chapter_number;
  if (chapterNumber !== undefined && Number.isFinite(chapterNumber) && chapterNumber !== 0) {
    await chapterRepository.updatePlaceholderChapterNumber(chapter_id, chapterNumber);
  }

  return await chapterRepository.getChapterId(chapter_id);
};

const markChapterAsRead = async (
  manga_slug: string,
  chapter_id: string,
  chapter_data?: ChapterProgressPayload,
  user_id?: string,
) => {
  try {
    await ensureChapterExists(chapter_id, chapter_data);

    let manga_id = '';
    const manga = await mangaRepository.getMangaIdBySlug(manga_slug, chapter_data?.source);
    if (manga) {
      manga_id = manga.id;
    }

    if (user_id) {
      const result = await userChapterStateRepository.upsert(user_id, chapter_id, {
        is_read: true,
      });
      // Best-effort, never blocks the response above — a tracker being slow or down
      // must not turn "mark chapter read" into a failure for something unrelated to
      // reading itself.
      if (manga_id) {
        trackerService.pushProgressIfLinked(user_id, manga_id).catch((error) => {
          console.error('[chapter.service] Tracker progress push failed:', error);
        });
      }
      return result;
    }

    const chapter = await chapterRepository.markChapterAsRead(manga_id, chapter_id);
    return chapter;
  } catch (error) {
    rethrowKnownOrWrap(error, new PrismaError('Failed to mark chapter as read'));
  }
};

const markChapterAsUnread = async (
  manga_slug: string,
  chapter_id: string,
  chapter_data?: ChapterProgressPayload,
  user_id?: string,
) => {
  try {
    await ensureChapterExists(chapter_id, chapter_data);

    if (user_id) {
      return await userChapterStateRepository.upsert(user_id, chapter_id, {
        is_read: false,
        last_page_read: 0,
      });
    }

    let manga_id = '';
    const manga = await mangaRepository.getMangaIdBySlug(manga_slug, chapter_data?.source);
    if (manga) {
      manga_id = manga.id;
    }

    const chapter = await chapterRepository.markChapterAsUnread(manga_id, chapter_id);
    return chapter;
  } catch (error) {
    rethrowKnownOrWrap(error, new PrismaError('Failed to mark chapter as unread'));
  }
};

const markChapterByLastPage = async (
  manga_slug: string,
  chapter_id: string,
  last_page_read: number,
  chapter_data: ChapterProgressPayload,
  user_id?: string,
) => {
  try {
    await ensureChapterExists(chapter_id, chapter_data);

    if (user_id) {
      // page_count is shared catalog metadata (same for every account), so it still
      // gets corrected on the shared row even though last_page_read itself is per-user.
      await chapterRepository.updateChapterPageCount(chapter_id, chapter_data?.page_count);
      return await userChapterStateRepository.upsert(user_id, chapter_id, { last_page_read });
    }

    let manga_id = '';
    const manga = await mangaRepository.getMangaIdBySlug(manga_slug, chapter_data?.source);
    if (manga) {
      manga_id = manga.id;
    }

    const chapter = await chapterRepository.markChapterByLastPage(
      manga_id,
      chapter_id,
      last_page_read,
      chapter_data?.page_count,
    );
    return chapter;
  } catch (error) {
    rethrowKnownOrWrap(error, new PrismaError('Failed to mark chapter by page count'));
  }
};

/** One chapter's worth of `markChaptersBulk` work. Chapters have no ordering dependency,
 * so the caller runs these concurrently via Promise.allSettled. */
const markOneChapterBulk = async (
  chapter: ChapterBulkPayload & { id: string },
  manga_id: string,
  manga_slug: string,
  markAsRead: boolean,
  mangaMeta: BulkMangaMeta | undefined,
  user_id: string | undefined,
): Promise<void> => {
  await ensureChapterExists(chapter.id, chapter);

  if (user_id) {
    await userChapterStateRepository.upsert(user_id, chapter.id, {
      is_read: markAsRead,
      ...(markAsRead ? {} : { last_page_read: 0 }),
    });
  } else if (markAsRead) {
    await chapterRepository.markChapterAsRead(manga_id, chapter.id);
  } else {
    await chapterRepository.markChapterAsUnread(manga_id, chapter.id);
  }

  if (chapter.source) {
    await historyRepository.addHistory(
      {
        source: chapter.source,
        manga_id: manga_id || undefined,
        manga_slug,
        source_manga_id: mangaMeta?.source_manga_id,
        chapter_id: chapter.id,
        pages_read: markAsRead ? chapter.page_count || 0 : 0,
        // Only meaningful when there's no manga row to join from; addHistory leaves
        // the stored values alone when these are absent.
        title: mangaMeta?.title,
        thumbnail_url: mangaMeta?.thumbnail_url,
      },
      user_id,
    );
  }
};

const BULK_MARK_CONCURRENCY = 25;

const markChaptersBulk = async (
  manga_slug: string,
  chapters: ChapterBulkPayload[],
  markAsRead: boolean,
  mangaMeta?: BulkMangaMeta,
  user_id?: string,
) => {
  try {
    let manga_id = '';
    const manga = await mangaRepository.getMangaIdBySlug(manga_slug, chapters[0]?.source);
    if (manga) {
      manga_id = manga.id;
    }

    const validChapters = chapters.filter((c): c is ChapterBulkPayload & { id: string } => !!c?.id);
    // Settled in slices: each chapter is several writes against SQLite's single writer, so
    // launching thousands at once only queues them ahead of every other request.
    const outcomes: PromiseSettledResult<unknown>[] = [];
    for (let start = 0; start < validChapters.length; start += BULK_MARK_CONCURRENCY) {
      outcomes.push(
        ...(await Promise.allSettled(
          validChapters
            .slice(start, start + BULK_MARK_CONCURRENCY)
            .map((chapter) =>
              markOneChapterBulk(chapter, manga_id, manga_slug, markAsRead, mangaMeta, user_id),
            ),
        )),
      );
    }

    let count = 0;
    const failed_chapter_ids: string[] = [];
    outcomes.forEach((outcome, i) => {
      if (outcome.status === 'fulfilled') {
        count += 1;
      } else {
        failed_chapter_ids.push(validChapters[i].id);
      }
    });

    // One push for the whole batch, not one per chapter: pushProgressIfLinked recomputes
    // the furthest-read chapter from user_chapter_state anyway, so per-chapter pushes
    // would send the same number N times and burn the tracker's rate limit doing it.
    // Mark-read only — progress is monotonic, so un-marking never pushes. Best-effort,
    // for the same reason as the single mark-read path above.
    if (user_id && manga_id && markAsRead && count > 0) {
      trackerService.pushProgressIfLinked(user_id, manga_id).catch((error) => {
        console.error('[chapter.service] Tracker progress push failed after bulk mark:', error);
      });
    }

    return { count, failed_chapter_ids };
  } catch (error) {
    rethrowKnownOrWrap(
      error,
      new PrismaError(
        markAsRead
          ? 'Failed to bulk mark chapters as read'
          : 'Failed to bulk mark chapters as unread',
      ),
    );
  }
};

const markPreviousChaptersAsRead = async (
  manga_slug: string,
  chapters: ChapterBulkPayload[],
  mangaMeta?: BulkMangaMeta,
  user_id?: string,
) => {
  return markChaptersBulk(manga_slug, chapters, true, mangaMeta, user_id);
};

const markPreviousChaptersAsUnread = async (
  manga_slug: string,
  chapters: ChapterBulkPayload[],
  mangaMeta?: BulkMangaMeta,
  user_id?: string,
) => {
  return markChaptersBulk(manga_slug, chapters, false, mangaMeta, user_id);
};

const getChapter = async (manga_slug: string, user_id?: string, source?: string) => {
  try {
    const manga = await mangaRepository.getMangaIdBySlug(manga_slug, source);

    if (!manga) {
      throw new MangaNotFoundError('Manga not found');
    }

    const chapters = await chapterRepository.getChapter(manga.id);
    if (!user_id) {
      return chapters;
    }

    const states = await userChapterStateRepository.getForChapters(
      user_id,
      chapters.map((c) => c.id),
    );
    const stateByChapter = new Map(states.map((s) => [s.chapter_id, s]));
    return chapters.map((c) => {
      const state = stateByChapter.get(c.id);
      return {
        ...c,
        is_read: state?.is_read ?? false,
        is_bookmark: state?.is_bookmark ?? false,
        last_page_read: state?.last_page_read ?? 0,
      };
    });
  } catch (error) {
    rethrowKnownOrWrap(error, new PrismaError('Failed to get chapter'));
  }
};

const getChapterProgressById = async (chapter_id: string, user_id?: string) => {
  try {
    if (user_id) {
      const state = await userChapterStateRepository.getEntry(user_id, chapter_id);
      return { last_page_read: state?.last_page_read ?? 0, is_read: state?.is_read ?? false };
    }
    const chapterProgress = await chapterRepository.getChapterProgressById(chapter_id);
    return chapterProgress;
  } catch (error) {
    rethrowKnownOrWrap(error, new PrismaError('Failed to get chapter progress by id'));
  }
};

const addChapter = async (manga_slug: string, chapterData: Chapters) => {
  try {
    const manga = await mangaRepository.getMangaIdBySlug(manga_slug);
    if (!manga) {
      throw new MangaNotFoundError('Manga not found');
    }
    const chapter = await chapterRepository.addChapter(manga.id, chapterData);
    return chapter;
  } catch (error) {
    console.error('[ChapterService.addChapter] Failed to add chapter', {
      manga_slug,
      chapter_id: chapterData?.id,
      chapter_number: chapterData?.chapter_number,
      error,
    });
    rethrowKnownOrWrap(error, new PrismaError('Failed to add chapter'));
  }
};

/** Batched counterpart to addChapter, used by the library update sweep. Returns how
 * many chapters were actually inserted — the sweep reports that as "new chapters", so it
 * must reflect real rows rather than the size of the batch it was handed. */
const addChapters = async (
  manga_slug: string,
  chapters: Chapters[],
  source?: string,
): Promise<number> => {
  if (chapters.length === 0) {
    return 0;
  }
  try {
    const manga = await mangaRepository.getMangaIdBySlug(manga_slug, source);
    if (!manga) {
      throw new MangaNotFoundError('Manga not found');
    }
    return await chapterRepository.addChapters(manga.id, chapters);
  } catch (error) {
    console.error('[ChapterService.addChapters] Failed to add chapters', {
      manga_slug,
      count: chapters.length,
      error,
    });
    rethrowKnownOrWrap(error, new PrismaError('Failed to add chapters'));
  }
};

const renumberChapters = async (changes: Array<{ id: string; chapter_number: number }>) => {
  try {
    return await chapterRepository.renumberChapters(changes);
  } catch (error) {
    rethrowKnownOrWrap(error, new PrismaError('Failed to renumber chapters'));
  }
};

const getChapterFetchDate = async () => {
  try {
    const chapters = await chapterRepository.getChapterFetchDate();
    return chapters;
  } catch (error) {
    rethrowKnownOrWrap(error, new PrismaError('Failed to get chapter fetch date'));
  }
};

const addChapterAsHistory = async (chapterData: Chapters) => {
  try {
    const existingChapter = await chapterRepository.getChapterId(chapterData.id);
    if (existingChapter) {
      return existingChapter;
    }

    const chapter = await chapterRepository.addChapterAsHistory(chapterData);
    return chapter;
  } catch (error) {
    rethrowKnownOrWrap(error, new PrismaError('Failed to add chapter as history'));
  }
};

const getChapterReadStatusById = async (chapter_id: string, user_id?: string) => {
  try {
    if (user_id) {
      const state = await userChapterStateRepository.getEntry(user_id, chapter_id);
      return { is_read: state?.is_read ?? false };
    }
    const chapterStatus = await chapterRepository.getChapterReadStatusById(chapter_id);
    return chapterStatus;
  } catch (error) {
    rethrowKnownOrWrap(error, new PrismaError('Failed to get chapter read status by id'));
  }
};

const chapterService = {
  markChapterAsRead,
  markChapterAsUnread,
  markChapterByLastPage,
  markPreviousChaptersAsRead,
  markPreviousChaptersAsUnread,
  getChapter,
  getChapterProgressById,
  addChapter,
  addChapters,
  renumberChapters,
  getChapterFetchDate,
  addChapterAsHistory,
  getChapterReadStatusById,
};

export default chapterService;
