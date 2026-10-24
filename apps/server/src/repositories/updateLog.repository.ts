import prisma from '../configs/prisma.config.js';
import type { UpdateLogKind } from '@projekt-manga/types';
export interface CreateUpdateLogEntry {
  source_id: string;
  manga_id?: string | null;
  kind: UpdateLogKind;
  message: string;
  detail: string;
}

const listRecent = async (limit: number) => {
  return await prisma.update_log.findMany({
    orderBy: { created_at: 'desc' },
    take: limit,
    include: {
      manga: { select: { id: true, slug: true, title: true, thumbnail_url: true } },
    },
  });
};

const create = async (entry: CreateUpdateLogEntry) => {
  return await prisma.update_log.create({ data: entry });
};

const updateLogRepository = {
  listRecent,
  create,
};

export default updateLogRepository;
