import prisma from '../configs/prisma.config.js';
import { applyLastWriteWins, editedBefore } from '../utils/syncMerge.js';
import type { ShelfStatus } from '@projekt-manga/types';
import { excludeExisting } from '../utils/skipDuplicates.js';
export interface UserMangaStatePatch {
  is_bookmarked?: boolean;
  shelf_status?: ShelfStatus | null;
  score?: number | null;
  notification_read?: boolean;
}

const getForUser = async (user_id: string) => {
  return await prisma.user_manga_state.findMany({ where: { user_id } });
};

const getEntry = async (user_id: string, manga_id: string) => {
  return await prisma.user_manga_state.findUnique({
    where: { user_id_manga_id: { user_id, manga_id } },
  });
};

const upsert = async (user_id: string, manga_id: string, patch: UserMangaStatePatch) => {
  return await prisma.user_manga_state.upsert({
    where: { user_id_manga_id: { user_id, manga_id } },
    create: { user_id, manga_id, ...patch },
    update: { ...patch, edited_at: null },
  });
};

const getChangedSince = async (user_id: string, since: Date, limit?: number, afterId?: string) => {
  return await prisma.user_manga_state.findMany({
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

/** No tombstone here (see the schema doc comment on user_manga_state) — a stale push is
 * simply skipped in favor of the server's newer row via last-write-wins. */
const applyIncoming = async (
  user_id: string,
  manga_id: string,
  patch: UserMangaStatePatch,
  updatedAt: Date,
) => {
  return applyLastWriteWins({
    updateIfOlder: () =>
      prisma.user_manga_state.updateMany({
        where: { user_id, manga_id, ...editedBefore(updatedAt) },
        data: { ...patch, edited_at: updatedAt },
      }),
    create: () =>
      prisma.user_manga_state.create({
        data: { user_id, manga_id, ...patch, edited_at: updatedAt },
      }),
  });
};

const claimFromAnonymous = async (
  user_id: string,
  rows: {
    manga_id: string;
    is_bookmarked: boolean;
    shelf_status: ShelfStatus | null;
    notification_read: boolean;
  }[],
) => {
  if (rows.length === 0) return;
  const existing = await prisma.user_manga_state.findMany({
    where: { user_id, manga_id: { in: rows.map((r) => r.manga_id) } },
    select: { manga_id: true },
  });

  const toCreate = excludeExisting(
    rows.map((r) => ({ user_id, ...r })),
    existing.map((r) => r.manga_id),
    (r) => r.manga_id,
  );
  if (toCreate.length > 0) {
    await prisma.user_manga_state.createMany({ data: toCreate });
  }
};

const userMangaStateRepository = {
  getForUser,
  getEntry,
  upsert,
  getChangedSince,
  applyIncoming,
  claimFromAnonymous,
};

export default userMangaStateRepository;
