import prisma from '../configs/prisma.config.js';
import type { Chapters } from '@projekt-manga/types';
import { withBusyRetry } from '../utils/sqliteRetry.js';
import type { ChapterSyncPlan } from '../utils/chapterSync.js';

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

/** One title's stored chapters, by source key, in one query. */
const findByKeys = async (source: string, manga_slug: string, keys: string[]) => {
  return await prisma.chapter.findMany({
    where: { source, manga_slug, source_chapter_key: { in: keys } },
  });
};

const setReadMany = async (manga_id: string, chapter_ids: string[], is_read: boolean) => {
  return await prisma.chapter.updateMany({
    where: { id: { in: chapter_ids } },
    data: {
      is_read,
      ...(manga_id ? { manga_id } : {}),
      ...(is_read ? {} : { last_page_read: 0 }),
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

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
type Db = Tx | typeof prisma;

/** A title as the chapter key scopes it. `id` is the manga row, when there is one. */
export interface TitleRef {
  id: string;
  source: string;
  slug: string;
}

/** How a chapter is named by anything that may not know its row: the source's own id for
 * it, within its title. */
export interface ChapterRef {
  source: string;
  manga_slug: string;
  source_chapter_key: string;
}

/** Catalog fields a caller can supply when a chapter row may have to be created. */
export type ChapterMeta = Partial<
  Pick<Chapters, 'url' | 'name' | 'scanlator' | 'chapter_number' | 'release_date' | 'page_count'>
>;

const keyOf = (title: Pick<TitleRef, 'source' | 'slug'>, source_chapter_key: string) => ({
  source: title.source,
  manga_slug: title.slug,
  source_chapter_key,
});

function isUniqueViolation(error: unknown) {
  return (error as { code?: string } | null)?.code === 'P2002';
}

function validDate(value: string | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The key of the chapter stored under row id `id`, for clients from before keys, which
 * name chapters by row id. With `source`/`mangaSlug`, only a row of that title counts.
 */
const keyOfRow = async (id: string, source?: string, mangaSlug?: string) => {
  const row = await prisma.chapter.findUnique({
    where: { id },
    select: { source: true, manga_slug: true, source_chapter_key: true },
  });
  if (!row || (source && row.source !== source) || (mangaSlug && row.manga_slug !== mangaSlug))
    return null;
  return row.source_chapter_key;
};

/** The source, title and key of the chapter stored under row id `id`, or null. */
const refOfRow = async (id: string): Promise<ChapterRef | null> =>
  prisma.chapter.findUnique({
    where: { id },
    select: { source: true, manga_slug: true, source_chapter_key: true },
  });

/**
 * Finds the chapter a source key names, creating a placeholder row when nothing has stored
 * it yet (a preview read, a sync push or a download from a device that saw it first). The
 * placeholder is attached to the title's manga row when one exists, and stays manga-less
 * otherwise; the library update adopts it later by the same key.
 *
 * An existing row only gains what it lacks — a manga link, a real chapter number — so a
 * caller's partial metadata never overwrites the source listing's.
 */
const resolveChapter = async (ref: ChapterRef, meta: ChapterMeta = {}, db: Db = prisma) => {
  const where = { source_manga_slug_source_chapter_key: ref };
  const manga = await db.manga.findUnique({
    where: { source_slug: { source: ref.source, slug: ref.manga_slug } },
    select: { id: true },
  });
  const existing = await db.chapter.findUnique({ where });
  if (existing) {
    const number = Number(meta.chapter_number);
    const data = {
      ...(!existing.manga_id && manga ? { manga_id: manga.id } : {}),
      ...(existing.chapter_number === 0 && Number.isFinite(number) && number > 0
        ? { chapter_number: number }
        : {}),
    };
    return Object.keys(data).length > 0
      ? db.chapter.update({ where: { id: existing.id }, data })
      : existing;
  }
  const number = Number(meta.chapter_number);
  try {
    return await db.chapter.create({
      data: {
        ...ref,
        manga_id: manga?.id ?? null,
        url: meta.url || '',
        name: meta.name || null,
        scanlator: meta.scanlator || null,
        chapter_number: Number.isFinite(number) && number >= 0 ? number : 0,
        release_date: validDate(meta.release_date),
        page_count: meta.page_count && meta.page_count > 0 ? meta.page_count : null,
      },
    });
  } catch (error) {
    // Two requests for the same unseen chapter race to create it; the loser uses the row.
    if (!isUniqueViolation(error)) throw error;
    return db.chapter.findUniqueOrThrow({ where });
  }
};

const findChapterByKey = async (ref: ChapterRef) =>
  prisma.chapter.findUnique({ where: { source_manga_slug_source_chapter_key: ref } });

function toChapterRow(manga_id: string, chapterData: Chapters, chapter_number: number) {
  return {
    manga_id,
    url: chapterData.url,
    name: chapterData.name,
    scanlator: chapterData.scanlator || null,
    chapter_number,
    // The source schema defaults a missing date to '', which is not a DateTime.
    release_date: chapterData.release_date || null,
    page_count: chapterData.page_count || null,
  };
}

/** Folds chapter row `fromId` into `intoId` and deletes it: each account's overlay,
 * history and downloads move across (downloads keep their files: the row carries its own
 * `file_path`). Read and bookmark merge as "either", progress as the furthest, matching
 * the monotonic rule sync applies to the same columns. Only needed when two rows turn out
 * to be one chapter — a relink onto a key a placeholder already holds. */
async function mergeChapterInto(tx: Tx, fromId: string, intoId: string) {
  const [from, into] = await Promise.all([
    tx.chapter.findUniqueOrThrow({ where: { id: fromId } }),
    tx.chapter.findUniqueOrThrow({ where: { id: intoId } }),
  ]);
  await tx.chapter.update({
    where: { id: intoId },
    data: {
      is_read: into.is_read || from.is_read,
      is_bookmark: into.is_bookmark || from.is_bookmark,
      last_page_read: Math.max(into.last_page_read, from.last_page_read),
      page_count: into.page_count || from.page_count,
    },
  });

  const states = await tx.user_chapter_state.findMany({ where: { chapter_id: fromId } });
  for (const state of states) {
    const existing = await tx.user_chapter_state.findUnique({
      where: { user_id_chapter_id: { user_id: state.user_id, chapter_id: intoId } },
    });
    if (!existing) {
      await tx.user_chapter_state.update({
        where: { id: state.id },
        data: { chapter_id: intoId },
      });
      continue;
    }
    await tx.user_chapter_state.update({
      where: { id: existing.id },
      data: {
        is_read: existing.is_read || state.is_read,
        is_bookmark: existing.is_bookmark || state.is_bookmark,
        last_page_read: Math.max(existing.last_page_read, state.last_page_read),
      },
    });
    await tx.user_chapter_state.delete({ where: { id: state.id } });
  }

  // History: one live row per reader (account, or the anonymous library) per chapter.
  // A row the other chapter already has for that reader is folded into it and left as a
  // tombstone, so other devices drop their copy. Moved rather than left on `fromId`,
  // whose delete would cascade and take the tombstone with it. sync_updated_at so other
  // devices pull every change.
  const now = new Date();
  const histories = await tx.history.findMany({ where: { chapter_id: fromId } });
  for (const row of histories) {
    const kept = row.deleted_at
      ? null
      : await tx.history.findFirst({
          where: { chapter_id: intoId, user_id: row.user_id, deleted_at: null },
        });
    if (kept) {
      await tx.history.update({
        where: { id: kept.id },
        data: {
          read_at: row.read_at < kept.read_at ? row.read_at : kept.read_at,
          last_read: row.last_read > kept.last_read ? row.last_read : kept.last_read,
          pages_read: Math.max(kept.pages_read, row.pages_read),
          time_read: kept.time_read + row.time_read,
          sync_updated_at: now,
        },
      });
    }
    await tx.history.update({
      where: { id: row.id },
      data: { chapter_id: intoId, sync_updated_at: now, ...(kept ? { deleted_at: now } : {}) },
    });
  }

  // Downloads: one row per chapter, the furthest along. A dropped row's pages stay on
  // disk, where Settings › Downloads lists them as orphaned folders to clean up.
  const rank = (status: string) =>
    ({ COMPLETED: 3, IN_PROGRESS: 2, PENDING: 1, PAUSED: 1 })[status] ?? 0;
  const [fromDownloads, intoDownloads] = await Promise.all([
    tx.download.findMany({ where: { chapter_id: fromId } }),
    tx.download.findMany({ where: { chapter_id: intoId } }),
  ]);
  const best = [...intoDownloads, ...fromDownloads].sort(
    (a, b) => rank(b.status) - rank(a.status),
  )[0];
  for (const download of [...intoDownloads, ...fromDownloads]) {
    if (download.id !== best.id) await tx.download.delete({ where: { id: download.id } });
  }
  if (best && best.chapter_id === fromId)
    await tx.download.update({ where: { id: best.id }, data: { chapter_id: intoId } });
  await tx.chapter.delete({ where: { id: fromId } });
}

/**
 * Points stored chapter `fromId` at the key the source now lists it under. The row keeps
 * its id, so its state, overlays, history and downloads stay exactly where they are; the
 * old `fetched_at` is kept so it does not sort or notify as new.
 *
 * A placeholder already holding the new key (a preview read of the relinked chapter
 * before the library caught up) is the same chapter, so it is folded into this row first.
 */
async function relinkChapter(
  tx: Tx,
  manga: TitleRef,
  fromId: string,
  chapterData: Chapters,
): Promise<boolean> {
  const from = await tx.chapter.findUnique({ where: { id: fromId } });
  if (!from || from.manga_id !== manga.id) return false;
  const placeholder = await tx.chapter.findUnique({
    where: { source_manga_slug_source_chapter_key: keyOf(manga, chapterData.id) },
  });
  if (placeholder) {
    if (placeholder.manga_id && placeholder.manga_id !== manga.id) return false;
    // Folded the other way round so this row's id survives: it is the one the library,
    // other devices and any open reader already know.
    await mergeChapterInto(tx, placeholder.id, fromId);
  }
  await tx.chapter.update({
    where: { id: fromId },
    data: {
      ...toChapterRow(manga.id, chapterData, Number(chapterData.chapter_number)),
      page_count: chapterData.page_count || from.page_count,
      source_chapter_key: chapterData.id,
    },
  });
  return true;
}

export interface AddedChapter {
  source_chapter_key: string;
  chapter_number: number;
  name: string | null;
}

const addedChapterOf = (chapter: Chapters): AddedChapter => ({
  source_chapter_key: chapter.id,
  chapter_number: Number(chapter.chapter_number),
  name: chapter.name || null,
});

export interface ChapterSyncResult {
  /** Chapters this title did not have before — what the update check reports as new. */
  added: number;
  /** Those chapters, so a caller can act on them (auto-download). */
  addedChapters: AddedChapter[];
  relinked: number;
  updated: number;
  removed: number;
}

/**
 * Applies a `planChapterSync` plan (utils/chapterSync.ts) for one title, atomically, so a
 * failure part-way leaves no half-applied relinks.
 *
 * Additions adopt placeholders that already hold their key (see `resolveChapter`). Stale chapters are removed only when nothing hangs off
 * them; one that was read, bookmarked, partly read, is in an account's overlay or history,
 * or was downloaded is kept, since a source dropping a chapter is not the user deleting
 * their record of reading it.
 */
/** Plan entries applied per transaction: short enough that progress saves and other
 * titles' syncs get the write lock between batches. */
const SYNC_BATCH = 100;

const applyChapterSync = async (
  manga: TitleRef,
  plan: ChapterSyncPlan,
): Promise<ChapterSyncResult> => {
  const manga_id = manga.id;
  const result: ChapterSyncResult = {
    added: 0,
    addedChapters: [],
    relinked: 0,
    updated: 0,
    removed: 0,
  };
  // A site restructure relinks every chapter of a long series. One transaction for all of
  // it would hold SQLite's write lock (and risk its timeout) for the whole run, so the plan
  // goes in batches. Each entry stands alone, and the next sync plans from what is stored,
  // so a run that stops between batches is finished by the next one.
  // Each batch returns what it did, counted only once it commits: a batch retried after
  // SQLITE_BUSY runs its work again and must not be counted twice.
  const inBatches = async <T>(
    items: T[],
    work: (tx: Tx, batch: T[]) => Promise<Partial<ChapterSyncResult>>,
  ) => {
    for (let at = 0; at < items.length; at += SYNC_BATCH) {
      const batch = items.slice(at, at + SYNC_BATCH);
      const done = await withBusyRetry(
        () => prisma.$transaction((tx) => work(tx, batch), { maxWait: 15_000, timeout: 30_000 }),
        'applyChapterSync',
      );
      result.updated += done.updated ?? 0;
      result.relinked += done.relinked ?? 0;
      result.added += done.added ?? 0;
      result.addedChapters.push(...(done.addedChapters ?? []));
    }
  };

  await inBatches(plan.updated, async (tx, batch) => {
    for (const { id, data } of batch) await tx.chapter.update({ where: { id }, data });
    return { updated: batch.length };
  });

  await inBatches(plan.relinked, async (tx, batch) => {
    let relinked = 0;
    for (const { fromId, chapter } of batch)
      if (await relinkChapter(tx, manga, fromId, chapter)) relinked++;
    return { relinked };
  });

  const additions = plan.added.filter((chapter) => {
    if (Number.isFinite(Number(chapter.chapter_number))) return true;
    console.warn(
      `[chapter.repository] Skipping chapter ${chapter.id} — invalid chapter_number: ${chapter.chapter_number}`,
    );
    return false;
  });
  await inBatches(additions, async (tx, batch) => {
    // Rows already holding one of these keys are placeholders with no manga row yet (the
    // title's own chapters were all in `stored`): adopt them.
    const existing = await tx.chapter.findMany({
      where: {
        source: manga.source,
        manga_slug: manga.slug,
        source_chapter_key: { in: batch.map((c) => c.id) },
      },
      select: { id: true, source_chapter_key: true },
    });
    const placeholder = new Map(existing.map((row) => [row.source_chapter_key, row.id]));
    const fetched_at = new Date();
    const toCreate = [];
    const added: AddedChapter[] = [];
    for (const chapter of batch) {
      const row = toChapterRow(manga_id, chapter, Number(chapter.chapter_number));
      const id = placeholder.get(chapter.id);
      if (id) {
        await tx.chapter.update({ where: { id }, data: { ...row, fetched_at } });
        added.push(addedChapterOf(chapter));
      } else {
        toCreate.push({ ...keyOf(manga, chapter.id), ...row, fetched_at });
      }
    }
    if (toCreate.length > 0) {
      await tx.chapter.createMany({ data: toCreate });
      added.push(
        ...toCreate.map((row) => ({
          source_chapter_key: row.source_chapter_key,
          chapter_number: row.chapter_number,
          name: row.name ?? null,
        })),
      );
    }
    return { added: added.length, addedChapters: added };
  });

  if (plan.stale.length > 0) {
    const removed = await withBusyRetry(
      () =>
        prisma.chapter.deleteMany({
          where: {
            id: { in: plan.stale },
            manga_id,
            is_read: false,
            is_bookmark: false,
            last_page_read: 0,
            user_chapter_state: { none: {} },
            history: { none: {} },
            download: { none: {} },
          },
        }),
      'applyChapterSync',
    );
    result.removed = removed.count;
  }

  return result;
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

/** The chapters of `manga_ids` numbered one of `numbers`: the same chapters on the other
 * sources of a merged title. */
const chaptersByNumber = async (manga_ids: string[], numbers: number[]) =>
  manga_ids.length === 0 || numbers.length === 0
    ? []
    : prisma.chapter.findMany({
        where: { manga_id: { in: manga_ids }, chapter_number: { in: numbers } },
        select: { id: true, manga_id: true, chapter_number: true },
      });

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

const chapterRepository = {
  markChapterAsRead,
  markChapterAsUnread,
  findByKeys,
  setReadMany,
  markChapterByLastPage,
  getChapter,
  getChapterProgressById,
  getChapterReadStatusById,
  getChapterWithMangaById,
  getChapterRowById,
  resolveChapter,
  chaptersByNumber,
  keyOfRow,
  refOfRow,
  findChapterByKey,
  applyChapterSync,
  updateChapterPageCount,
  listChaptersWithState,
  getChapterFetchDate,
};

export default chapterRepository;
