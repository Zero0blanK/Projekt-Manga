import type { Chapters } from '@projekt-manga/types';
import type { AddChapterAsHistoryBody } from '@projekt-manga/schemas';
import chapterRepository from '../repositories/chapter.repository.js';
import historyRepository from '../repositories/history.repository.js';
import mangaRepository from '../repositories/manga.repository.js';
import userChapterStateRepository from '../repositories/userChapterState.repository.js';
import trackerService from './tracker.service.js';
import mangaLinkRepository from '../repositories/mangaLink.repository.js';
import {
  MangaNotFoundError,
  PrismaError,
  ValidationError,
  rethrowKnownOrWrap,
} from '../utils/customErrors.js';
import { planChapterSync } from '../utils/chapterSync.js';

type ChapterBulkPayload = Partial<Chapters> & { source?: string };
type ChapterProgressPayload = Partial<Chapters> & { source?: string };
type BulkMangaMeta = { source_manga_id?: string; title?: string; thumbnail_url?: string };

/**
 * The row a progress write lands on, created if no stored list has it yet. Clients name
 * chapters by the source's key within the title — the only name a preview read or a
 * device that has never synced this title knows — never by row id. `source` comes from
 * the request, or from the one stored title with this slug.
 */
const resolveForWrite = async (
  manga_slug: string,
  source_chapter_key: string,
  chapter_data?: ChapterProgressPayload,
) => {
  let source = chapter_data?.source;
  if (!source) {
    const manga = await mangaRepository.getMangaIdBySlug(manga_slug);
    source = manga ? (await mangaRepository.getMangaById(manga.id))?.source : undefined;
  }
  if (!source) throw new ValidationError('source is required for a title that is not stored');
  return chapterRepository.resolveChapter(
    { source, manga_slug, source_chapter_key },
    chapter_data ?? {},
  );
};

/**
 * Merged titles (Linked sources): a chapter read or unread on one source of a group is
 * read or unread on the others too, matched by chapter number, so the library's progress
 * and unread count follow the main title whichever source a chapter was read on.
 * Best-effort: the reader's own write has already succeeded and stays that way.
 */
export async function shareReadState(
  manga_id: string | null | undefined,
  numbers: number[],
  is_read: boolean,
  user_id?: string,
) {
  // 0 is "no number" for extras and placeholders: never shared.
  const shared = [...new Set(numbers.filter((n) => Number.isFinite(n) && n > 0))];
  if (!manga_id || shared.length === 0) return;
  try {
    const { primary_id, links } = await mangaLinkRepository.groupFor(manga_id, user_id ?? null);
    const others = [primary_id, ...links.map((link) => link.linked.id)].filter(
      (id) => id !== manga_id,
    );
    for (const chapter of await chapterRepository.chaptersByNumber(others, shared)) {
      if (user_id)
        await userChapterStateRepository.upsert(user_id, chapter.id, {
          is_read,
          ...(is_read ? {} : { last_page_read: 0 }),
        });
      else if (is_read)
        await chapterRepository.markChapterAsRead(chapter.manga_id ?? '', chapter.id);
      else await chapterRepository.markChapterAsUnread(chapter.manga_id ?? '', chapter.id);
    }
  } catch (error) {
    console.error('[chapter.service] Sharing read state with linked sources failed:', error);
  }
}

const markChapterAsRead = async (
  manga_slug: string,
  source_chapter_key: string,
  chapter_data?: ChapterProgressPayload,
  user_id?: string,
) => {
  try {
    const chapter = await resolveForWrite(manga_slug, source_chapter_key, chapter_data);

    if (user_id) {
      const result = await userChapterStateRepository.upsert(user_id, chapter.id, {
        is_read: true,
      });
      await shareReadState(chapter.manga_id, [chapter.chapter_number], true, user_id);
      // Best-effort, never blocks the response above — a tracker being slow or down
      // must not turn "mark chapter read" into a failure for something unrelated to
      // reading itself.
      if (chapter.manga_id) {
        trackerService.pushProgressIfLinked(user_id, chapter.manga_id).catch((error) => {
          console.error('[chapter.service] Tracker progress push failed:', error);
        });
      }
      return result;
    }

    const result = await chapterRepository.markChapterAsRead('', chapter.id);
    await shareReadState(chapter.manga_id, [chapter.chapter_number], true);
    return result;
  } catch (error) {
    rethrowKnownOrWrap(error, new PrismaError('Failed to mark chapter as read'));
  }
};

const markChapterAsUnread = async (
  manga_slug: string,
  source_chapter_key: string,
  chapter_data?: ChapterProgressPayload,
  user_id?: string,
) => {
  try {
    const chapter = await resolveForWrite(manga_slug, source_chapter_key, chapter_data);

    if (user_id) {
      const result = await userChapterStateRepository.upsert(user_id, chapter.id, {
        is_read: false,
        last_page_read: 0,
      });
      await shareReadState(chapter.manga_id, [chapter.chapter_number], false, user_id);
      return result;
    }

    const result = await chapterRepository.markChapterAsUnread('', chapter.id);
    await shareReadState(chapter.manga_id, [chapter.chapter_number], false);
    return result;
  } catch (error) {
    rethrowKnownOrWrap(error, new PrismaError('Failed to mark chapter as unread'));
  }
};

const markChapterByLastPage = async (
  manga_slug: string,
  source_chapter_key: string,
  last_page_read: number,
  chapter_data: ChapterProgressPayload,
  user_id?: string,
) => {
  try {
    const chapter = await resolveForWrite(manga_slug, source_chapter_key, chapter_data);

    if (user_id) {
      // page_count is shared catalog metadata (same for every account), so it still
      // gets corrected on the shared row even though last_page_read itself is per-user.
      await chapterRepository.updateChapterPageCount(chapter.id, chapter_data?.page_count);
      return await userChapterStateRepository.upsert(user_id, chapter.id, { last_page_read });
    }

    return await chapterRepository.markChapterByLastPage(
      '',
      chapter.id,
      last_page_read,
      chapter_data?.page_count,
    );
  } catch (error) {
    rethrowKnownOrWrap(error, new PrismaError('Failed to mark chapter by page count'));
  }
};

/** Chapters written together. Short enough that one slice doesn't hold SQLite's single
 * writer against every other request for long. */
const BULK_MARK_SLICE = 200;

type BulkChapter = ChapterBulkPayload & { id: string };

/** The stored row for each chapter, in as few queries as the list allows. Only a chapter
 * with no usable row yet costs a write of its own. One that can't be resolved goes in
 * `failed`; the rest carry on. */
const resolveBulkRows = async (slice: BulkChapter[], manga_id: string, manga_slug: string) => {
  const stored = new Map<string, Awaited<ReturnType<typeof resolveForWrite>>>();
  const sources = new Set(slice.flatMap((chapter) => chapter.source ?? []));
  for (const source of sources) {
    const keys = slice.filter((chapter) => chapter.source === source).map((chapter) => chapter.id);
    const rows = await chapterRepository.findByKeys(source, manga_slug, keys);
    for (const row of rows) stored.set(`${source}\0${row.source_chapter_key}`, row);
  }

  const resolved: Array<{
    chapter: BulkChapter;
    row: Awaited<ReturnType<typeof resolveForWrite>>;
  }> = [];
  const failed: string[] = [];
  for (const chapter of slice) {
    const row = stored.get(`${chapter.source}\0${chapter.id}`);
    // A placeholder gets its title and number filled in by resolveChapter.
    const settled = row && row.chapter_number !== 0 && (row.manga_id || !manga_id);
    try {
      resolved.push({
        chapter,
        row: settled ? row : await resolveForWrite(manga_slug, chapter.id, chapter),
      });
    } catch {
      failed.push(chapter.id);
    }
  }
  return { resolved, failed };
};

/** Read state and history for one slice. All or nothing: the caller reports the slice. */
const writeBulkSlice = async (
  resolved: Array<{ chapter: BulkChapter; row: { id: string } }>,
  manga_id: string,
  manga_slug: string,
  markAsRead: boolean,
  mangaMeta: BulkMangaMeta | undefined,
  user_id: string | undefined,
) => {
  const ids = resolved.map(({ row }) => row.id);
  if (user_id) {
    await (markAsRead
      ? userChapterStateRepository.markManyRead(user_id, ids)
      : userChapterStateRepository.markManyUnread(user_id, ids));
  } else {
    await chapterRepository.setReadMany(manga_id, ids, markAsRead);
  }

  const bySource = new Map<string, typeof resolved>();
  for (const entry of resolved) {
    const { source } = entry.chapter;
    if (source) bySource.set(source, [...(bySource.get(source) ?? []), entry]);
  }
  for (const [source, entries] of bySource) {
    await historyRepository.addHistoryBatch(
      entries.map(({ chapter, row }) => ({
        chapter_id: row.id,
        pages_read: markAsRead ? chapter.page_count || 0 : 0,
      })),
      {
        source,
        manga_id: manga_id || undefined,
        manga_slug,
        source_manga_id: mangaMeta?.source_manga_id,
        // Only meaningful when there's no manga row to join from.
        title: mangaMeta?.title,
        thumbnail_url: mangaMeta?.thumbnail_url,
      },
      user_id,
    );
  }
};

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

    const validChapters = chapters.filter((c): c is BulkChapter => !!c?.id);
    const written: BulkChapter[] = [];
    const failed_source_chapter_keys: string[] = [];
    for (let start = 0; start < validChapters.length; start += BULK_MARK_SLICE) {
      const { resolved, failed } = await resolveBulkRows(
        validChapters.slice(start, start + BULK_MARK_SLICE),
        manga_id,
        manga_slug,
      );
      failed_source_chapter_keys.push(...failed);
      try {
        await writeBulkSlice(resolved, manga_id, manga_slug, markAsRead, mangaMeta, user_id);
        written.push(...resolved.map(({ chapter }) => chapter));
      } catch {
        failed_source_chapter_keys.push(...resolved.map(({ chapter }) => chapter.id));
      }
    }

    const count = written.length;
    await shareReadState(
      manga_id,
      written.map((chapter) => Number(chapter.chapter_number)),
      markAsRead,
      user_id,
    );

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

    return { count, failed_source_chapter_keys };
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

/**
 * Brings a stored title's chapters in line with the source's current list — new chapters,
 * changed metadata, and chapters the source now lists under a different key, which keep
 * their row (and so their state). See utils/chapterSync.ts.
 *
 * Reads the shared rows, not an account's overlay: the plan is about which chapter rows
 * exist.
 */
const syncChapters = async (manga_slug: string, latest: Chapters[], source?: string) => {
  try {
    const found = await mangaRepository.getMangaIdBySlug(manga_slug, source);
    const manga = found ? await mangaRepository.getMangaById(found.id) : null;
    if (!manga) {
      throw new MangaNotFoundError('Manga not found');
    }
    const stored = await chapterRepository.getChapter(manga.id);
    const plan = planChapterSync(stored, latest);
    if (plan.suspicious) {
      console.warn(
        `[ChapterService.syncChapters] ${source ?? '?'}/${manga_slug}: most stored chapters are ` +
          'missing from the source and few match by number; keeping them and only adding.',
      );
    }
    const result = await chapterRepository.applyChapterSync(manga, plan);
    return { ...result, suspicious: plan.suspicious };
  } catch (error) {
    console.error('[ChapterService.syncChapters] Failed to sync chapters', {
      manga_slug,
      count: latest.length,
      error,
    });
    rethrowKnownOrWrap(error, new PrismaError('Failed to sync chapters'));
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

/** Stores a chapter a client read before any list had it. Keyed like every client
 * write: by the source's key within its title. */
const addChapterAsHistory = async (chapterData: AddChapterAsHistoryBody) => {
  try {
    const { source, manga_slug, id, ...meta } = chapterData;
    return await chapterRepository.resolveChapter(
      { source, manga_slug, source_chapter_key: id },
      meta,
    );
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
  syncChapters,
  getChapterFetchDate,
  addChapterAsHistory,
  getChapterReadStatusById,
};

export default chapterService;
