import prisma from '../configs/prisma.config.js';
import type { Chapters } from '@projekt-manga/types';
import { excludeExisting } from '../utils/skipDuplicates.js';

// `manga_id` is only spread into `data` when truthy, here and in the two functions below —
// the caller's slug lookup can miss and pass `''`, and writing that would blank the
// chapter's already-correct manga link instead of leaving it alone.
const markChapterAsRead = async (manga_id: string, chapter_id: string) => {
  return await prisma.chapter.updateMany({
    where: {
      id: chapter_id,
    },
    data: {
      is_read: true,
      ...(manga_id ? { manga_id } : {}),
    },
  });
};

const markChapterAsUnread = async (manga_id: string, chapter_id: string) => {
  return await prisma.chapter.updateMany({
    where: {
      id: chapter_id,
    },
    data: {
      is_read: false,
      ...(manga_id ? { manga_id } : {}),
      last_page_read: 0,
    },
  });
};

const markChapterByLastPage = async (
  manga_id: string,
  chapter_id: string,
  last_page_read: number,
  page_count?: number,
) => {
  return await prisma.chapter.updateMany({
    where: {
      id: chapter_id,
    },
    data: {
      last_page_read: last_page_read,
      ...(manga_id ? { manga_id } : {}),
      ...(page_count && page_count > 0 ? { page_count } : {}),
    },
  });
};

const getChapter = async (manga_id: string) => {
  return await prisma.chapter.findMany({
    where: {
      manga_id: manga_id,
    },
  });
};

const getChapterProgressById = async (chapter_id: string) => {
  return await prisma.chapter.findUnique({
    where: {
      id: chapter_id,
    },
    select: {
      last_page_read: true,
      is_read: true,
    },
  });
};

const getChapterId = async (chapter_id: string) => {
  return await prisma.chapter.findUnique({
    where: {
      id: chapter_id,
    },
    select: {
      id: true,
      is_read: true,
      chapter_number: true,
    },
  });
};

const updatePlaceholderChapterNumber = async (chapter_id: string, chapter_number: number) => {
  return prisma.chapter.updateMany({
    where: { id: chapter_id, chapter_number: 0 },
    data: { chapter_number },
  });
};

/** Rewrites stored chapter numbers that differ from what the source reports. */
const renumberChapters = async (changes: Array<{ id: string; chapter_number: number }>) => {
  if (changes.length === 0) return 0;
  await prisma.$transaction(
    changes.map(({ id, chapter_number }) =>
      prisma.chapter.update({ where: { id }, data: { chapter_number } }),
    ),
  );
  return changes.length;
};

const getChapterReadStatusById = async (chapter_id: string) => {
  return await prisma.chapter.findUnique({
    where: {
      id: chapter_id,
    },
    select: {
      is_read: true,
    },
  });
};

const getChapterWithMangaById = async (chapter_id: string) => {
  return await prisma.chapter.findUnique({
    where: {
      id: chapter_id,
    },
    include: {
      manga: true,
    },
  });
};

const getChapterRowById = async (chapter_id: string) => {
  return await prisma.chapter.findUnique({
    where: {
      id: chapter_id,
    },
  });
};

/**
 * Creates the chapter row a download needs when the source reported a chapter that was
 * never persisted. `url` is a placeholder built from the source/slug rather than the real
 * page URL — the worker re-fetches the page list from the source anyway, and the column
 * is NOT NULL.
 */
const createChapterForDownload = async (data: {
  id: string;
  manga_id: string;
  url: string;
  name: string;
  chapter_number: number;
}) => {
  return await prisma.chapter.create({
    data: {
      id: data.id,
      manga_id: data.manga_id,
      url: data.url,
      name: data.name,
      chapter_number: data.chapter_number,
      fetched_at: new Date(),
    },
  });
};

/**
 * Links an existing chapter to a manga. Used when a chapter exists only as a
 * history/read-status placeholder (`manga_id` null, keyed on source + slug) and a
 * download needs `download.manga_id`, which is required.
 */
const linkChapterToManga = async (chapter_id: string, manga_id: string) => {
  return await prisma.chapter.update({
    where: {
      id: chapter_id,
    },
    data: {
      manga_id,
    },
  });
};

const addChapter = async (manga_id: string, chapterData: Chapters) => {
  const normalizedChapterNumber = Number(chapterData.chapter_number);
  if (!Number.isFinite(normalizedChapterNumber)) {
    throw new Error(
      `Invalid chapter_number for chapter ${chapterData.id}: ${chapterData.chapter_number}`,
    );
  }

  const existingChapter = await prisma.chapter.findUnique({
    where: {
      id: chapterData.id,
    },
  });

  if (existingChapter) {
    return await prisma.chapter.update({
      where: {
        id: existingChapter.id,
      },
      data: {
        manga_id: manga_id,
        chapter_number: normalizedChapterNumber,
        release_date: chapterData.release_date,
        page_count: chapterData.page_count || null,
        scanlator: chapterData.scanlator || null,
      },
    });
  }

  return prisma.chapter.create({
    data: {
      id: chapterData.id,
      manga_id: manga_id,
      url: chapterData.url,
      name: chapterData.name,
      scanlator: chapterData.scanlator || null,
      chapter_number: normalizedChapterNumber,
      fetched_at: new Date().toISOString(),
      release_date: chapterData.release_date,
      page_count: chapterData.page_count || null,
    },
  });
};

/**
 * Inserts a batch of chapters the caller has already diffed against what's stored.
 *
 * Duplicates are filtered out rather than upserted per row: callers pass only chapters
 * they believe are new, so any duplicate was inserted by a concurrent sweep between the
 * diff and this write, and keeping the existing row is correct. This also keeps the batch
 * to a few INSERTs. (Prisma's `skipDuplicates` is unsupported by the SQLite connector —
 * see utils/skipDuplicates.ts.)
 *
 * A chapter with an unusable chapter_number is skipped rather than thrown, so one bad
 * scraped row doesn't block the rest. Returns how many rows were actually created.
 */
const addChapters = async (manga_id: string, chapters: Chapters[]): Promise<number> => {
  const rows = [];
  for (const chapterData of chapters) {
    const normalizedChapterNumber = Number(chapterData.chapter_number);
    if (!Number.isFinite(normalizedChapterNumber)) {
      console.warn(
        `[chapter.repository] Skipping chapter ${chapterData.id} — invalid chapter_number: ${chapterData.chapter_number}`,
      );
      continue;
    }
    rows.push({
      id: chapterData.id,
      manga_id,
      url: chapterData.url,
      name: chapterData.name,
      scanlator: chapterData.scanlator || null,
      chapter_number: normalizedChapterNumber,
      fetched_at: new Date().toISOString(),
      release_date: chapterData.release_date,
      page_count: chapterData.page_count || null,
    });
  }

  if (rows.length === 0) {
    return 0;
  }

  // `id` is the primary key, so "already present" is a straight id lookup.
  const existing = await prisma.chapter.findMany({
    where: { id: { in: rows.map((r) => r.id) } },
    select: { id: true },
  });

  const toCreate = excludeExisting(
    rows,
    existing.map((r) => r.id),
    (r) => r.id,
  );
  if (toCreate.length === 0) {
    return 0;
  }

  const result = await prisma.chapter.createMany({ data: toCreate });
  return result.count;
};

/** Shared-catalog correction used by the logged-in mark-by-page path: page_count is
 * catalog metadata (same for every account), so it still gets corrected on the shared
 * row even though last_page_read for a logged-in user goes to user_chapter_state
 * instead of this table. */
const updateChapterPageCount = async (chapter_id: string, page_count?: number) => {
  if (!page_count || page_count <= 0) {
    return;
  }
  await prisma.chapter.updateMany({
    where: { id: chapter_id },
    data: { page_count },
  });
};

/** Used only by auth.service's "first account claims existing anonymous data" — every
 * chapter with real progress worth carrying over (skips the shared catalog's untouched
 * chapters so a fresh account doesn't get a default-state row per chapter ever fetched). */
const listChaptersWithState = async () => {
  return await prisma.chapter.findMany({
    where: { OR: [{ is_read: true }, { last_page_read: { gt: 0 } }, { is_bookmark: true }] },
    select: { id: true, is_read: true, is_bookmark: true, last_page_read: true },
  });
};

const getChapterFetchDate = async () => {
  return await prisma.chapter.findMany({
    where: {
      fetched_at: {
        not: null,
      },
      manga_id: {
        not: null,
      },
    },
    orderBy: {
      release_date: 'desc',
    },
    include: {
      manga: true,
    },
    take: 10,
  });
};

const addChapterAsHistory = async (chapterData: Chapters) => {
  const last_page = chapterData.last_page_read || chapterData.page_count || 0;
  return await prisma.chapter.create({
    data: {
      id: chapterData.id,
      manga_id: undefined,
      url: chapterData.url,
      name: chapterData.name,
      scanlator: chapterData.scanlator || undefined,
      chapter_number: chapterData.chapter_number,
      fetched_at: undefined,
      release_date: chapterData.release_date,
      last_page_read: last_page,
      page_count: chapterData.page_count || undefined,
    },
  });
};

const ensureChapterForProgress = async (chapterData: Chapters) => {
  return prisma.chapter.upsert({
    where: { id: chapterData.id },
    create: {
      id: chapterData.id,
      url: chapterData.url,
      name: chapterData.name,
      scanlator: chapterData.scanlator || undefined,
      chapter_number: chapterData.chapter_number,
      release_date: chapterData.release_date,
      last_page_read: chapterData.last_page_read || 0,
      page_count: chapterData.page_count || undefined,
    },
    update: {},
  });
};

const chapterRepository = {
  markChapterAsRead,
  markChapterAsUnread,
  markChapterByLastPage,
  getChapter,
  getChapterProgressById,
  getChapterId,
  updatePlaceholderChapterNumber,
  renumberChapters,
  getChapterReadStatusById,
  getChapterWithMangaById,
  getChapterRowById,
  createChapterForDownload,
  linkChapterToManga,
  addChapter,
  addChapters,
  updateChapterPageCount,
  listChaptersWithState,
  getChapterFetchDate,
  addChapterAsHistory,
  ensureChapterForProgress,
};

export default chapterRepository;
