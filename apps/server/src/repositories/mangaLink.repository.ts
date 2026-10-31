import prisma from '../configs/prisma.config.js';
import type { Prisma } from '@prisma/client';
import { ValidationError, NotFoundError } from '../utils/customErrors.js';

/** A library entry may draw on at most this many other sources. */
export const MAX_LINKS = 20;

const linkedSelect = {
  id: true,
  title: true,
  author: true,
  slug: true,
  source: true,
  thumbnail_url: true,
} as const;

type LinkClient = Prisma.TransactionClient | typeof prisma;

/** The primary a title belongs to: itself, unless it is linked under another. */
async function primaryOf(manga_id: string, user_id: string | null, client: LinkClient = prisma) {
  const link = await client.manga_link.findFirst({
    where: { linked_id: manga_id, user_id },
    select: { primary_id: true },
  });
  return link?.primary_id ?? manga_id;
}

/**
 * The group a title is part of, for this identity: its primary and the linked titles in
 * the order they are tried. Asking with a linked title gives the same group as asking with
 * its primary.
 */
const groupFor = async (manga_id: string, user_id: string | null) => {
  const primary_id = await primaryOf(manga_id, user_id);
  const links = await prisma.manga_link.findMany({
    where: { primary_id, user_id },
    orderBy: [{ priority: 'asc' }, { created_at: 'asc' }],
    select: { id: true, priority: true, linked: { select: linkedSelect } },
  });
  return { primary_id, links };
};

/** Every group this identity has, for the library update (it checks linked titles too). */
const listAll = async (user_id: string | null) => {
  const rows = await prisma.manga_link.findMany({
    where: { user_id },
    orderBy: [{ primary_id: 'asc' }, { priority: 'asc' }],
    select: { primary_id: true, linked: { select: linkedSelect } },
  });
  const groups = new Map<string, Array<(typeof rows)[number]['linked']>>();
  for (const row of rows)
    groups.set(row.primary_id, [...(groups.get(row.primary_id) ?? []), row.linked]);
  return [...groups].map(([primary_id, linked]) => ({ primary_id, linked }));
};

/**
 * Links `linked_id` under `primary_id`, last in priority. Refused when it would make a
 * chain or a second home for a title: a linked title has no links of its own, a primary
 * is not itself linked, and a title is linked under one primary at most.
 */
const create = async (
  primary_id: string,
  linked_id: string,
  user_id: string | null,
  client?: Prisma.TransactionClient,
) => {
  const run = async (tx: Prisma.TransactionClient) => {
    if (primary_id === linked_id) throw new ValidationError('A title cannot be linked to itself');
    const found = await tx.manga.findMany({
      where: { id: { in: [primary_id, linked_id] } },
      select: { id: true },
    });
    if (found.length !== 2) throw new NotFoundError('Title not found');
    if ((await primaryOf(primary_id, user_id, tx)) !== primary_id)
      throw new ValidationError('This title is itself linked to another; link to that one instead');
    if (await tx.manga_link.findFirst({ where: { primary_id: linked_id, user_id } }))
      throw new ValidationError('That title has linked sources of its own');
    const existing = await tx.manga_link.findFirst({ where: { linked_id, user_id } });
    if (existing) {
      if (existing.primary_id === primary_id) return existing;
      throw new ValidationError('That title is already linked to another');
    }
    const siblings = await tx.manga_link.findMany({
      where: { primary_id, user_id },
      select: { priority: true },
    });
    if (siblings.length >= MAX_LINKS)
      throw new ValidationError(`A title can draw on at most ${MAX_LINKS} other sources`);
    return tx.manga_link.create({
      data: {
        primary_id,
        linked_id,
        user_id,
        priority: Math.max(-1, ...siblings.map((row) => row.priority)) + 1,
      },
    });
  };
  return client ? run(client) : prisma.$transaction(run);
};

/** Sets the order linked titles are tried in. `link_ids` must be exactly the group's links. */
const reorder = async (primary_id: string, link_ids: string[], user_id: string | null) =>
  prisma.$transaction(async (tx) => {
    const links = await tx.manga_link.findMany({
      where: { primary_id, user_id },
      select: { id: true },
    });
    const known = new Set(links.map((link) => link.id));
    if (link_ids.length !== known.size || !link_ids.every((id) => known.has(id)))
      throw new ValidationError('The order must list each linked source once');
    for (const [priority, id] of link_ids.entries())
      await tx.manga_link.update({ where: { id }, data: { priority } });
  });

/** Unlinks one source. Only this identity's own link can be removed. */
const remove = async (primary_id: string, link_id: string, user_id: string | null) => {
  const { count } = await prisma.manga_link.deleteMany({
    where: { id: link_id, primary_id, user_id },
  });
  if (count === 0) throw new NotFoundError('Linked source not found');
};

/** For backups: each primary's linked titles in order, keyed by primary id. */
const linksForPrimaries = async (primary_ids: string[], user_id: string | null) => {
  if (primary_ids.length === 0)
    return new Map<
      string,
      Array<{
        priority: number;
        linked: {
          source: string;
          slug: string;
          title: string;
          author: string;
          thumbnail_url: string;
        };
      }>
    >();
  const rows = await prisma.manga_link.findMany({
    where: { primary_id: { in: primary_ids }, user_id },
    orderBy: [{ priority: 'asc' }, { created_at: 'asc' }],
    select: { primary_id: true, priority: true, linked: { select: linkedSelect } },
  });
  const map = new Map<string, Array<(typeof rows)[number]>>();
  for (const row of rows) map.set(row.primary_id, [...(map.get(row.primary_id) ?? []), row]);
  return map;
};

const mangaLinkRepository = { groupFor, listAll, create, reorder, remove, linksForPrimaries };

export default mangaLinkRepository;
