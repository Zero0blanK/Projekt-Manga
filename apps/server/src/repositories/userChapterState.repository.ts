import prisma from '../configs/prisma.config.js';
import { excludeExisting } from '../utils/skipDuplicates.js';

export interface UserChapterStatePatch {
  is_read?: boolean;
  is_bookmark?: boolean;
  last_page_read?: number;
}

const getForUser = async (user_id: string) => {
  return await prisma.user_chapter_state.findMany({ where: { user_id } });
};

const getEntry = async (user_id: string, chapter_id: string) => {
  return await prisma.user_chapter_state.findUnique({
    where: { user_id_chapter_id: { user_id, chapter_id } },
  });
};

const getForChapters = async (user_id: string, chapter_ids: string[]) => {
  if (chapter_ids.length === 0) return [];
  return await prisma.user_chapter_state.findMany({
    where: { user_id, chapter_id: { in: chapter_ids } },
  });
};

const upsert = async (user_id: string, chapter_id: string, patch: UserChapterStatePatch) => {
  return await prisma.user_chapter_state.upsert({
    where: { user_id_chapter_id: { user_id, chapter_id } },
    create: { user_id, chapter_id, ...patch },
    update: patch,
  });
};

/**
 * Marks a whole set of chapters read in two statements instead of one upsert per chapter.
 *
 * Create-then-update, and both are needed: `createMany` inserts only the rows that don't
 * exist yet, so the `updateMany` afterwards flips `is_read` on rows that were already
 * there. Only `is_read` is written — `last_page_read` and `is_bookmark` belong to the
 * reader and must survive a tracker-driven advance.
 */
const markManyRead = async (user_id: string, chapter_ids: string[]): Promise<void> => {
  if (chapter_ids.length === 0) {
    return;
  }
  const existing = await prisma.user_chapter_state.findMany({
    where: { user_id, chapter_id: { in: chapter_ids } },
    select: { chapter_id: true },
  });

  const toCreate = excludeExisting(
    chapter_ids.map((chapter_id) => ({ user_id, chapter_id, is_read: true })),
    existing.map((r) => r.chapter_id),
    (r) => r.chapter_id,
  );
  if (toCreate.length > 0) {
    await prisma.user_chapter_state.createMany({ data: toCreate });
  }

  await prisma.user_chapter_state.updateMany({
    where: { user_id, chapter_id: { in: chapter_ids }, is_read: false },
    data: { is_read: true },
  });
};

const getChangedSince = async (user_id: string, since: Date, limit?: number, afterId?: string) => {
  return await prisma.user_chapter_state.findMany({
    where: {
      user_id,
      ...(afterId
        ? { OR: [{ updated_at: { gt: since } }, { updated_at: since, id: { gt: afterId } }] }
        : { updated_at: { gte: since } }),
    },
    orderBy: [{ updated_at: 'asc' }, { id: 'asc' }],
    ...(limit !== undefined ? { take: limit } : {}),
  });
};

/** The one merge path with no "discard the stale side" branch: is_read/last_page_read
 * use monotonic union (can only advance, never regress) regardless of which side is
 * newer, so every push updates the row. is_bookmark is the one field that still follows
 * plain last-write-wins, since there's no sane "union" for a toggle. */
const mergeIncoming = async (
  user_id: string,
  chapter_id: string,
  incoming: { is_read: boolean; is_bookmark: boolean; last_page_read: number; updated_at: Date },
) => {
  const existing = await prisma.user_chapter_state.findUnique({
    where: { user_id_chapter_id: { user_id, chapter_id } },
  });
  if (!existing) {
    return await prisma.user_chapter_state.create({
      data: {
        user_id,
        chapter_id,
        is_read: incoming.is_read,
        is_bookmark: incoming.is_bookmark,
        last_page_read: incoming.last_page_read,
      },
    });
  }

  const serverWins = existing.updated_at >= incoming.updated_at;
  return await prisma.user_chapter_state.update({
    where: { user_id_chapter_id: { user_id, chapter_id } },
    data: {
      is_read: existing.is_read || incoming.is_read,
      last_page_read: Math.max(existing.last_page_read, incoming.last_page_read),
      is_bookmark: serverWins ? existing.is_bookmark : incoming.is_bookmark,
    },
  });
};

const claimFromAnonymous = async (
  user_id: string,
  rows: { chapter_id: string; is_read: boolean; is_bookmark: boolean; last_page_read: number }[],
) => {
  if (rows.length === 0) return;
  const existing = await prisma.user_chapter_state.findMany({
    where: { user_id, chapter_id: { in: rows.map((r) => r.chapter_id) } },
    select: { chapter_id: true },
  });

  const toCreate = excludeExisting(
    rows.map((r) => ({ user_id, ...r })),
    existing.map((r) => r.chapter_id),
    (r) => r.chapter_id,
  );
  if (toCreate.length > 0) {
    await prisma.user_chapter_state.createMany({ data: toCreate });
  }
};

const userChapterStateRepository = {
  getForUser,
  getEntry,
  getForChapters,
  upsert,
  markManyRead,
  getChangedSince,
  mergeIncoming,
  claimFromAnonymous,
};

export default userChapterStateRepository;
