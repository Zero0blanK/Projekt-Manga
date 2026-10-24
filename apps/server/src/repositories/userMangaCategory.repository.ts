import prisma from '../configs/prisma.config.js';
import { applyLastWriteWins, editedBefore } from '../utils/syncMerge.js';
import { excludeExisting, compositeKey } from '../utils/skipDuplicates.js';

const getForUser = async (user_id: string) => {
  return await prisma.user_manga_category.findMany({ where: { user_id, deleted_at: null } });
};

const getForManga = async (user_id: string, manga_id: string) => {
  return await prisma.user_manga_category.findMany({
    where: { user_id, manga_id, deleted_at: null },
  });
};

const getMangaIdsForCategory = async (user_id: string, category_id: string) => {
  const rows = await prisma.user_manga_category.findMany({
    where: { user_id, category_id, deleted_at: null },
    select: { manga_id: true },
  });
  return rows.map((r) => r.manga_id);
};

const assign = async (user_id: string, manga_id: string, category_id: string) => {
  return await prisma.user_manga_category.upsert({
    where: { user_id_manga_id_category_id: { user_id, manga_id, category_id } },
    create: { user_id, manga_id, category_id },
    update: { deleted_at: null, edited_at: null },
  });
};

const getChangedSince = async (user_id: string, since: Date, limit?: number, afterId?: string) => {
  return await prisma.user_manga_category.findMany({
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

const applyIncoming = async (
  user_id: string,
  manga_id: string,
  category_id: string,
  deleted_at: Date | null,
  updatedAt: Date,
) => {
  return applyLastWriteWins({
    updateIfOlder: () =>
      prisma.user_manga_category.updateMany({
        where: { user_id, manga_id, category_id, ...editedBefore(updatedAt) },
        data: { deleted_at, edited_at: updatedAt },
      }),
    create: () =>
      prisma.user_manga_category.create({
        data: { user_id, manga_id, category_id, deleted_at, edited_at: updatedAt },
      }),
  });
};

const claimFromAnonymous = async (
  user_id: string,
  rows: { manga_id: string; category_id: string }[],
) => {
  if (rows.length === 0) return;
  // Composite (manga_id, category_id) key: a title can be in several categories and a
  // category holds several titles, so neither half alone identifies a row.
  const existingRows = await prisma.user_manga_category.findMany({
    where: { user_id },
    select: { manga_id: true, category_id: true },
  });
  const existing = existingRows.map((r) => compositeKey(r.manga_id, r.category_id));

  const toCreate = excludeExisting(
    rows.map((r) => ({ user_id, ...r })),
    existing,
    (r) => compositeKey(r.manga_id, r.category_id),
  );
  if (toCreate.length > 0) {
    await prisma.user_manga_category.createMany({ data: toCreate });
  }
};

const userMangaCategoryRepository = {
  getForUser,
  getForManga,
  getMangaIdsForCategory,
  assign,
  getChangedSince,
  applyIncoming,
  claimFromAnonymous,
};

export default userMangaCategoryRepository;
