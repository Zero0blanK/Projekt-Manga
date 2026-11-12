import { Prisma } from '@prisma/client';
import mangaRepository from '../repositories/manga.repository.js';
import userLibraryRepository from '../repositories/userLibrary.repository.js';
import userMangaCategoryRepository from '../repositories/userMangaCategory.repository.js';
import categoryRepository from '../repositories/category.repository.js';
import {
  MangaNotFoundError,
  NotFoundError,
  DuplicateResourceError,
  ValidationError,
  PrismaError,
  rethrowKnownOrWrap,
} from '../utils/customErrors.js';
import thumbnailQueue from '../workers/thumbnailSync.js';
import cacheRepository from '../repositories/cache.repository.js';
import storage from '../utils/storage.js';
import type { GetMangaOptions, AddMangaPayload } from '@projekt-manga/types';

const getManga = async (options: GetMangaOptions, user_id?: string) => {
  const manga = user_id
    ? await mangaRepository.getMangaForUser(user_id, options)
    : await mangaRepository.getManga(options);

  return manga;
};

const getMangaById = async (manga_id: string) => {
  const manga = await mangaRepository.getMangaById(manga_id);

  return manga;
};

type StoredDetails = NonNullable<Awaited<ReturnType<typeof mangaRepository.getMangaDetailsById>>>;

const toMangaDetails = (manga: StoredDetails) => {
  const detail = Array.isArray(manga.manga_detail) ? manga.manga_detail[0] : manga.manga_detail;

  const { manga_detail, chapter, ...rest } = manga;
  return {
    ...rest,
    status: detail?.status ?? 'UNKNOWN',
    genres: detail?.genres ?? '',
    description: detail?.description ?? '',
    rating: detail?.rating ?? null,
    artist: detail?.artist ?? null,
    chapters: manga.chapter || [],
  };
};

const getMangaDetailsById = async (manga_id: string, user_id?: string) => {
  const manga = user_id
    ? await mangaRepository.getMangaDetailsByIdForUser(user_id, manga_id)
    : await mangaRepository.getMangaDetailsById(manga_id);

  if (!manga) {
    throw new MangaNotFoundError('Manga not found');
  }
  return toMangaDetails(manga);
};

/** Many titles' details at once, leaving out any that have gone. */
const getMangaDetailsByIds = async (manga_ids: string[], user_id?: string) =>
  (await mangaRepository.getMangaDetailsByIds(manga_ids, user_id)).map(toMangaDetails);

const addManga = async (manga_data: AddMangaPayload, user_id?: string) => {
  try {
    const manga = await mangaRepository.addManga(manga_data, user_id);
    if (user_id && manga_data.in_library !== false) {
      await userLibraryRepository.setInLibrary(user_id, manga.id, true);
    }
    if (manga.thumbnail_url) {
      thumbnailQueue.enqueue(manga.id, manga.thumbnail_url, { sourceId: manga.source });
    }
    // The response reflects this account's membership, even when the shared row is
    // intentionally kept outside the anonymous library.
    return user_id && manga_data.in_library !== false ? { ...manga, in_library: true } : manga;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        throw new DuplicateResourceError('Manga already exists in library');
      }
      if (error.code === 'P2003') {
        throw new ValidationError('Foreign key constraint violation');
      }
    }
    rethrowKnownOrWrap(error, new PrismaError('Failed to add manga'));
  }
};

const deleteManga = async (manga_id: string, user_id?: string) => {
  const manga = await mangaRepository.getMangaById(manga_id);
  if (!manga) {
    throw new MangaNotFoundError('Manga not found');
  }

  // The manga row, its chapters and its cover are shared by every account, so a signed-in
  // caller only removes the title from their own library.
  if (user_id) {
    await userLibraryRepository.setInLibrary(user_id, manga.id, false);
    return true;
  }
  // Anonymous callers share one identity: once any account has tracked the title the row
  // is no longer theirs to delete, so it just leaves the shared library.
  if (await userLibraryRepository.hasAnyEntry(manga.id)) {
    await mangaRepository.setInLibrary(manga.id, false);
    return true;
  }

  const cached = await cacheRepository.findByMangaId(manga.id);
  await mangaRepository.deleteManga(manga.id);
  if (cached?.thumbnail_url) {
    await storage.removeCachedThumbnail(cached.thumbnail_url).catch((error) => {
      console.error('Failed to remove deleted manga thumbnail', error);
    });
  }
  return true;
};

const assertOwnCategory = async (category_id: string, user_id?: string) => {
  if (!(await categoryRepository.getCategoryById(category_id, user_id ?? null))) {
    throw new NotFoundError('Category not found');
  }
};

const addMangaToCategory = async (manga_slug: string, category_id: string, user_id?: string) => {
  try {
    await assertOwnCategory(category_id, user_id);
    const manga = await mangaRepository.getMangaIdBySlug(manga_slug);

    if (!manga) {
      throw new MangaNotFoundError('Manga not found');
    }

    const mangaCategory = user_id
      ? await userMangaCategoryRepository.assign(user_id, manga.id, category_id)
      : await mangaRepository.addMangaToCategory(manga.id, category_id);
    return mangaCategory;
  } catch (error) {
    rethrowKnownOrWrap(error, new PrismaError('Failed to add manga to category'));
  }
};

const getMangaByCategoryId = async (
  category_id: string,
  options: GetMangaOptions,
  user_id?: string,
) => {
  try {
    await assertOwnCategory(category_id, user_id);
    const manga = user_id
      ? await mangaRepository.getMangaByCategoryIdForUser(user_id, category_id, options)
      : await mangaRepository.getMangaByCategoryId(category_id, options);
    return manga;
  } catch (error) {
    rethrowKnownOrWrap(error, new PrismaError('Failed to get manga by category id'));
  }
};

const setInLibrary = async (manga_id: string, in_library: boolean, user_id?: string) => {
  const manga = await mangaRepository.getMangaById(manga_id);
  if (!manga) {
    throw new MangaNotFoundError();
  }
  if (user_id) {
    return await userLibraryRepository.setInLibrary(user_id, manga.id, in_library);
  }
  return await mangaRepository.setInLibrary(manga.id, in_library);
};

const mangaService = {
  getManga,
  getMangaById,
  getMangaDetailsById,
  getMangaDetailsByIds,
  setInLibrary,
  addManga,
  deleteManga,
  addMangaToCategory,
  getMangaByCategoryId,
};

export default mangaService;
