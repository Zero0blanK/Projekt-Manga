import prisma from '../configs/prisma.config.js';
import type { Prisma, manga_override } from '@prisma/client';

/** The editable fields of an override. `undefined` leaves a field as it is; `null` clears it
 * so the catalog value shows through again. */
export type MangaOverrideFields = {
  title?: string | null;
  author?: string | null;
  description?: string | null;
  status?: string | null;
  cover_path?: string | null;
};

type OverrideClient = Prisma.TransactionClient | typeof prisma;

const isEmpty = (row: MangaOverrideFields) =>
  row.title == null &&
  row.author == null &&
  row.description == null &&
  row.status == null &&
  row.cover_path == null;

/** `user_id: null` is the anonymous identity. Prisma reads a null filter as IS NULL. */
const find = (manga_id: string, user_id: string | null, client: OverrideClient = prisma) =>
  client.manga_override.findFirst({ where: { manga_id, user_id } });

/** This identity's overrides for the given titles, keyed by manga id. */
const mapForManga = async (
  manga_ids: string[],
  user_id: string | null,
): Promise<Map<string, manga_override>> => {
  if (manga_ids.length === 0) return new Map();
  const rows = await prisma.manga_override.findMany({
    where: { manga_id: { in: manga_ids }, user_id },
  });
  return new Map(rows.map((row) => [row.manga_id, row]));
};

/**
 * Applies a partial edit to this identity's override, creating it on first use.
 *
 * The read-then-write runs in one transaction, which SQLite serializes, so two concurrent
 * edits meet the same row; the unique indexes are what guarantee one row per identity. A
 * write that leaves every field null removes the row, so an emptied override reads exactly
 * like none.
 */
const upsert = async (
  manga_id: string,
  user_id: string | null,
  fields: MangaOverrideFields,
  client?: Prisma.TransactionClient,
) => {
  const run = async (tx: Prisma.TransactionClient) => {
    const existing = await find(manga_id, user_id, tx);
    if (existing) {
      const merged = { ...existing, ...fields };
      if (isEmpty(merged)) {
        await tx.manga_override.delete({ where: { id: existing.id } });
        return { previous: existing, current: null };
      }
      const current = await tx.manga_override.update({ where: { id: existing.id }, data: fields });
      return { previous: existing, current };
    }
    if (isEmpty(fields)) return { previous: null, current: null };
    const current = await tx.manga_override.create({ data: { manga_id, user_id, ...fields } });
    return { previous: null, current };
  };
  return client ? run(client) : prisma.$transaction(run);
};

/** "Reset to source": drops every edit this identity made to the title. */
const remove = async (manga_id: string, user_id: string | null) => {
  return prisma.$transaction(async (tx) => {
    const existing = await find(manga_id, user_id, tx);
    if (existing) await tx.manga_override.delete({ where: { id: existing.id } });
    return existing;
  });
};

/** Every override this identity holds, for a backup export. */
const listForOwner = (user_id: string | null) =>
  prisma.manga_override.findMany({
    where: { user_id },
    include: { manga: { select: { source: true, slug: true } } },
    orderBy: { manga_id: 'asc' },
  });

/** Cover files still referenced, so the thumbnail prune keeps them. */
const listCoverPaths = async () => {
  const rows = await prisma.manga_override.findMany({
    where: { cover_path: { not: null } },
    select: { cover_path: true },
  });
  return rows.flatMap((row) => (row.cover_path ? [row.cover_path] : []));
};

const mangaOverrideRepository = {
  find,
  mapForManga,
  upsert,
  remove,
  listForOwner,
  listCoverPaths,
};

export default mangaOverrideRepository;
