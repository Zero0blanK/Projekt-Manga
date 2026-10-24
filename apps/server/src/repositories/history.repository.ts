import prisma from '../configs/prisma.config.js';
import type { MangaHistory } from '@projekt-manga/types';
import { withBusyRetry } from '../utils/sqliteRetry.js';
import { DuplicateResourceError } from '../utils/customErrors.js';

const getHistory = async (user_id?: string) => {
  const rows = await prisma.history.findMany({
    // Anonymous reads only ever see anonymous rows (user_id: null) — without this filter,
    // once an account exists every browser session would see that account's private
    // reading history by default.
    where: { user_id: user_id ?? null, deleted_at: null },
    orderBy: [{ last_read: 'desc' }, { id: 'desc' }],
    include: {
      chapter: {
        select: {
          id: true,
          name: true,
          chapter_number: true,
          is_read: true,
          last_page_read: true,
          page_count: true,
        },
      },
      manga: { select: { slug: true, title: true, thumbnail_url: true, in_library: true } },
    },
  });

  // Rows with a null manga relation (e.g. after the library entry was deleted) fall back
  // to a title/thumbnail looked up by source + slug.
  const slugsMissingManga = [...new Set(rows.filter((r) => !r.manga).map((r) => r.manga_slug))];

  const mangaBySlug = new Map<string, { title: string; thumbnail_url: string }>();
  if (slugsMissingManga.length > 0) {
    const mangas = await prisma.manga.findMany({
      where: { slug: { in: slugsMissingManga } },
      select: { source: true, slug: true, title: true, thumbnail_url: true },
    });
    for (const m of mangas) {
      mangaBySlug.set(`${m.source}\0${m.slug}`, { title: m.title, thumbnail_url: m.thumbnail_url });
    }
  }

  // Logged-in reads overlay is_read/last_page_read from this account's own progress —
  // the shared chapter row's columns belong to the anonymous state, not any one account.
  const chapterIds = rows.map((r) => r.chapter_id).filter((id): id is string => !!id);
  const stateByChapter = new Map<string, { is_read: boolean; last_page_read: number }>();
  const accountLibraryIds = new Set<string>();
  if (user_id && chapterIds.length > 0) {
    const states = await prisma.user_chapter_state.findMany({
      where: { user_id, chapter_id: { in: chapterIds } },
    });
    for (const s of states) {
      stateByChapter.set(s.chapter_id, { is_read: s.is_read, last_page_read: s.last_page_read });
    }
  }
  if (user_id) {
    const mangaIds = [...new Set(rows.map((r) => r.manga_id).filter((id): id is string => !!id))];
    if (mangaIds.length > 0) {
      const membership = await prisma.user_library.findMany({
        where: { user_id, manga_id: { in: mangaIds }, deleted_at: null },
        select: { manga_id: true },
      });
      for (const entry of membership) accountLibraryIds.add(entry.manga_id);
    }
  }

  return rows.map((row) => {
    const fallback = mangaBySlug.get(`${row.source}\0${row.manga_slug}`);
    const overlay = row.chapter_id ? stateByChapter.get(row.chapter_id) : undefined;
    return {
      id: row.id,
      source: row.source,
      manga_id: row.manga_id ?? undefined,
      in_library: row.manga_id
        ? user_id
          ? accountLibraryIds.has(row.manga_id)
          : (row.manga?.in_library ?? false)
        : false,
      manga_slug: row.manga_slug,
      source_manga_id: row.source_manga_id ?? undefined,
      chapter_id: row.chapter_id ?? undefined,
      pages_read: row.pages_read,
      time_read: row.time_read,
      last_read: row.last_read,
      read_at: row.read_at,
      title:
        row.title && row.title !== row.manga_id && row.title !== row.manga_slug
          ? row.title
          : (row.manga?.title ?? fallback?.title ?? row.title ?? undefined),
      thumbnail_url:
        row.thumbnail_url ?? row.manga?.thumbnail_url ?? fallback?.thumbnail_url ?? undefined,
      chapter_number: row.chapter?.chapter_number ?? undefined,
      name: row.chapter?.name ?? undefined,
      is_read: user_id ? (overlay?.is_read ?? false) : (row.chapter?.is_read ?? undefined),
      last_page_read: user_id ? (overlay?.last_page_read ?? 0) : (row.chapter?.last_page_read ?? 0),
      page_count: row.chapter?.page_count ?? 0,
    };
  });
};

const addHistory = async (historyData: MangaHistory, user_id?: string) => {
  let mangaId = historyData.manga_id;
  if (!mangaId && historyData.manga_slug) {
    const manga = await prisma.manga.findUnique({
      where: { source_slug: { source: historyData.source, slug: historyData.manga_slug } },
      select: { id: true },
    });
    mangaId = manga?.id;
  }
  let chapterId = historyData.chapter_id;
  if (!chapterId && historyData.manga_slug) {
    // Falls back to the manga's highest-numbered chapter when the caller gave no chapter id.
    const chapter = await prisma.chapter.findFirst({
      where: { manga: { source: historyData.source, slug: historyData.manga_slug } },
      orderBy: { chapter_number: 'desc' },
      select: { id: true },
    });
    chapterId = chapter?.id;
  }

  // Scoped to the same account (or the same anonymous null bucket) so two accounts
  // reading the same chapter never collide onto one row.
  return withBusyRetry(
    () =>
      prisma.$transaction(async (tx) => {
        if (chapterId) {
          // Progress and history are sent as separate requests (and as independent
          // beacons on exit). History can arrive first; stand up the nullable chapter
          // row so the history write never loses the race to a foreign key constraint.
          await tx.chapter.upsert({
            where: { id: chapterId },
            create: { id: chapterId, url: '', chapter_number: 0 },
            update: {},
          });
        }
        const existingHistory = await tx.history.findFirst({
          where: {
            source: historyData.source,
            manga_slug: historyData.manga_slug,
            chapter_id: chapterId,
            user_id: user_id ?? null,
          },
        });
        const now = new Date();
        const syncUpdatedAt = new Date(
          Math.max(now.getTime(), (existingHistory?.sync_updated_at?.getTime() ?? 0) + 1),
        );
        if (existingHistory) {
          return tx.history.update({
            where: { id: existingHistory.id },
            data: {
              last_read: now,
              sync_updated_at: syncUpdatedAt,
              deleted_at: null,
              pages_read: historyData.pages_read,
              time_read: { increment: historyData.time_read || 0 },
              manga_id: mangaId ?? existingHistory.manga_id,
              chapter_id: chapterId ?? existingHistory.chapter_id,
              source_manga_id: historyData.source_manga_id ?? existingHistory.source_manga_id,
              ...(historyData.title ? { title: historyData.title } : {}),
              ...(historyData.thumbnail_url ? { thumbnail_url: historyData.thumbnail_url } : {}),
            },
          });
        }
        return tx.history.create({
          data: {
            manga_id: mangaId,
            chapter_id: chapterId,
            source: historyData.source,
            manga_slug: historyData.manga_slug,
            source_manga_id: historyData.source_manga_id,
            title: historyData.title,
            thumbnail_url: historyData.thumbnail_url,
            pages_read: historyData.pages_read || 1,
            time_read: historyData.time_read || 0,
            read_at: now,
            last_read: now,
            sync_updated_at: syncUpdatedAt,
            user_id: user_id ?? null,
          },
        });
      }),
    'addHistory',
  );
};

const getHistoryByMangaSlug = async (manga_slug: string, user_id?: string, source?: string) => {
  return await prisma.history.findMany({
    where: {
      manga_slug: manga_slug,
      ...(source ? { source } : {}),
      user_id: user_id ?? null,
      deleted_at: null,
    },
    include: {
      chapter: {
        select: {
          id: true,
          chapter_number: true,
          name: true,
          is_read: true,
          last_page_read: true,
          page_count: true,
        },
      },
    },
  });
};

/** Hard-deletes an anonymous row. Logged-in deletes go through softDeleteHistory instead
 * — sync needs a tombstone to tell other devices a row was removed, which a real DELETE
 * would lose. */
const deleteHistory = async (id: string) => {
  return await prisma.history.deleteMany({ where: { id, user_id: null } });
};

const softDeleteHistory = async (id: string, user_id: string) => {
  const deletedAt = new Date();
  return await prisma.history.updateMany({
    where: { id, user_id },
    data: { deleted_at: deletedAt, last_read: deletedAt, sync_updated_at: deletedAt },
  });
};

/** Pull by server mutation time, not client read time. */
const getChangedSince = async (user_id: string, since: Date, limit?: number, afterId?: string) => {
  return await prisma.history.findMany({
    where: {
      user_id,
      ...(afterId
        ? {
            OR: [
              { sync_updated_at: { gt: since } },
              { sync_updated_at: since, id: { gt: afterId } },
            ],
          }
        : { sync_updated_at: { gte: since } }),
    },
    orderBy: [{ sync_updated_at: 'asc' }, { id: 'asc' }],
    ...(limit !== undefined ? { take: limit } : {}),
  });
};

/** Applies one incoming sync row via last-write-wins on last_read, keyed by the client-
 * generated id. A stale push (the server's row is already newer) is discarded. */
const applyIncoming = async (
  user_id: string,
  row: {
    id: string;
    source: string;
    manga_id: string | null;
    manga_slug: string;
    source_manga_id: string | null;
    title: string | null;
    thumbnail_url: string | null;
    chapter_id: string | null;
    read_at: Date;
    last_read: Date;
    pages_read: number;
    time_read: number;
    deleted_at: Date | null;
  },
) => {
  const existing = await prisma.history.findUnique({ where: { id: row.id } });
  // history is keyed on its own id alone (unlike the user_* overlay tables, which are keyed
  // on {user_id, X}), so a pushed row whose client-generated id collides with another
  // account's row must be rejected rather than overwrite it or be returned to the caller.
  // A real collision between cuid2 ids is astronomically unlikely; this is defense in depth.
  if (existing && existing.user_id !== user_id) {
    throw new DuplicateResourceError('History id belongs to another account');
  }
  if (existing && existing.last_read >= row.last_read) {
    return existing;
  }
  return await prisma.history.upsert({
    where: { id: row.id },
    create: { ...row, user_id, sync_updated_at: new Date() },
    update: {
      source: row.source,
      manga_id: row.manga_id,
      manga_slug: row.manga_slug,
      source_manga_id: row.source_manga_id,
      title: row.title,
      thumbnail_url: row.thumbnail_url,
      chapter_id: row.chapter_id,
      read_at: row.read_at,
      last_read: row.last_read,
      pages_read: row.pages_read,
      time_read: row.time_read,
      deleted_at: row.deleted_at,
      sync_updated_at: new Date(),
    },
  });
};

/** One-time bulk claim for "the first account claims existing anonymous data" — stamps
 * every anonymous row's user_id in one statement. */
const claimAllAnonymous = async (user_id: string) => {
  await prisma.history.updateMany({
    where: { user_id: null },
    data: { user_id, sync_updated_at: new Date() },
  });
};

const historyRepository = {
  getHistory,
  addHistory,
  getHistoryByMangaSlug,
  deleteHistory,
  softDeleteHistory,
  getChangedSince,
  applyIncoming,
  claimAllAnonymous,
};

export default historyRepository;
