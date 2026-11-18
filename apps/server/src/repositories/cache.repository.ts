import prisma from '../configs/prisma.config.js';

const findByMangaId = async (manga_id: string) => {
  return await prisma.cache.findUnique({ where: { manga_id } });
};

const findBySha = async (sha256: string) => {
  return await prisma.cache.findFirst({ where: { sha256_url: sha256 } });
};

const listPrivateUrls = async (): Promise<Set<string>> => {
  const rows = await prisma.cache.findMany({ select: { thumbnail_url: true } });
  return new Set(rows.map((row) => row.thumbnail_url).filter((url): url is string => !!url));
};

const upsertByMangaId = async (manga_id: string, thumbnail_url: string, sha256: string) => {
  return await prisma.cache.upsert({
    where: { manga_id },
    create: { manga_id, thumbnail_url: thumbnail_url, sha256_url: sha256 },
    update: { thumbnail_url: thumbnail_url, sha256_url: sha256 },
  });
};

/** Library titles (anyone's) whose cover isn't stored here yet, and can be fetched. */
const listLibraryTitlesWithoutCover = async (limit: number) =>
  prisma.manga.findMany({
    where: {
      cache: null,
      thumbnail_url: { startsWith: 'http' },
      OR: [{ in_library: true }, { user_library: { some: { deleted_at: null } } }],
    },
    select: { id: true, thumbnail_url: true, source: true },
    take: limit,
  });

const cacheRepository = {
  findByMangaId,
  findBySha,
  listPrivateUrls,
  listLibraryTitlesWithoutCover,
  upsertByMangaId,
};

export default cacheRepository;
