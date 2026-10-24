import prisma from '../configs/prisma.config.js';
import type { ShelfStatus } from '@projekt-manga/types';
export interface LibraryStatePatch {
  is_bookmarked?: boolean;
  shelf_status?: ShelfStatus | null;
  notification_read?: boolean;
}

const getAll = async () => {
  return await prisma.manga_library.findMany();
};

const getByMangaId = async (manga_id: string) => {
  return await prisma.manga_library.findUnique({ where: { manga_id } });
};

const upsert = async (manga_id: string, patch: LibraryStatePatch) => {
  return await prisma.manga_library.upsert({
    where: { manga_id },
    create: { manga_id, ...patch },
    update: patch,
  });
};

const libraryRepository = {
  getAll,
  getByMangaId,
  upsert,
};

export default libraryRepository;
