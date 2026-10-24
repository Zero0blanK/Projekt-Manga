import prisma from '../configs/prisma.config.js';
import { applyLastWriteWins, editedBefore } from '../utils/syncMerge.js';
import { excludeExisting } from '../utils/skipDuplicates.js';

const getForUser = async (user_id: string) => {
  return await prisma.user_library.findMany({ where: { user_id, deleted_at: null } });
};

const getEntry = async (user_id: string, manga_id: string) => {
  return await prisma.user_library.findUnique({
    where: { user_id_manga_id: { user_id, manga_id } },
  });
};

const setInLibrary = async (user_id: string, manga_id: string, inLibrary: boolean) => {
  const deleted_at = inLibrary ? null : new Date();
  return await prisma.user_library.upsert({
    where: { user_id_manga_id: { user_id, manga_id } },
    create: { user_id, manga_id, deleted_at },
    update: { deleted_at, edited_at: null },
  });
};

/** True when any account has ever tracked this title, even if it has since left their library. */
const hasAnyEntry = async (manga_id: string) => {
  return (await prisma.user_library.count({ where: { manga_id } })) > 0;
};

const getUserIdsForManga = async (manga_id: string) => {
  const rows = await prisma.user_library.findMany({
    where: { manga_id, deleted_at: null },
    select: { user_id: true },
  });
  return rows.map((r) => r.user_id);
};

const getChangedSince = async (user_id: string, since: Date, limit?: number, afterId?: string) => {
  return await prisma.user_library.findMany({
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

/** Applies one incoming sync row via last-write-wins on updated_at — a stale push (the
 * server's row is already newer) is silently discarded rather than overwritten. */
const applyIncoming = async (
  user_id: string,
  manga_id: string,
  deleted_at: Date | null,
  updatedAt: Date,
) => {
  return applyLastWriteWins({
    updateIfOlder: () =>
      prisma.user_library.updateMany({
        where: { user_id, manga_id, ...editedBefore(updatedAt) },
        data: { deleted_at, edited_at: updatedAt },
      }),
    create: () =>
      prisma.user_library.create({
        data: { user_id, manga_id, deleted_at, edited_at: updatedAt },
      }),
  });
};

/** One-time bulk claim for "the first account claims existing anonymous data" — used
 * only from auth.service's register flow. skipDuplicates makes it safe to call
 * idempotently. */
const claimFromAnonymous = async (user_id: string, manga_ids: string[]) => {
  if (manga_ids.length === 0) return;
  const existing = await prisma.user_library.findMany({
    where: { user_id, manga_id: { in: manga_ids } },
    select: { manga_id: true },
  });

  const toCreate = excludeExisting(
    manga_ids.map((manga_id) => ({ user_id, manga_id })),
    existing.map((r) => r.manga_id),
    (r) => r.manga_id,
  );
  if (toCreate.length > 0) {
    await prisma.user_library.createMany({ data: toCreate });
  }
};

const userLibraryRepository = {
  getForUser,
  getEntry,
  setInLibrary,
  hasAnyEntry,
  getUserIdsForManga,
  getChangedSince,
  applyIncoming,
  claimFromAnonymous,
};

export default userLibraryRepository;
