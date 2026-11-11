import crypto from 'node:crypto';
import type { manga_override } from '@prisma/client';
import {
  MANGA_COVER_MAX_BYTES,
  type UpdateMangaOverrideBody,
  type UploadMangaCoverBody,
} from '@projekt-manga/schemas';
import mangaRepository from '../repositories/manga.repository.js';
import mangaOverrideRepository from '../repositories/mangaOverride.repository.js';
import storage from '../utils/storage.js';
import { detectRasterImageType } from '../utils/imageContent.js';
import {
  MangaNotFoundError,
  PayloadTooLargeError,
  ValidationError,
} from '../utils/customErrors.js';

const extensionByType: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
};

/** The client never sees where a cover file lives, only whether there is one. */
const toView = (row: manga_override | null) =>
  row
    ? {
        manga_id: row.manga_id,
        title: row.title,
        author: row.author,
        description: row.description,
        status: row.status,
        has_cover: row.cover_path != null,
        updated_at: row.updated_at,
      }
    : null;

const requireManga = async (manga_id: string) => {
  const manga = await mangaRepository.getMangaById(manga_id);
  if (!manga) throw new MangaNotFoundError();
  return manga;
};

/** Best effort: a leftover file is collected by the thumbnail prune later. */
const removeCoverFile = async (cover_path: string | null | undefined) => {
  if (!cover_path) return;
  await storage.removeCachedThumbnail(cover_path).catch((error) => {
    console.error('Failed to remove replaced custom cover', error);
  });
};

const updateOverride = async (
  manga_id: string,
  body: UpdateMangaOverrideBody,
  user_id?: string,
) => {
  const manga = await requireManga(manga_id);
  const { current } = await mangaOverrideRepository.upsert(manga.id, user_id ?? null, body);
  return toView(current);
};

/** "Reset to source": drops every edit, the custom cover included. */
const resetOverride = async (manga_id: string, user_id?: string) => {
  const manga = await requireManga(manga_id);
  const removed = await mangaOverrideRepository.remove(manga.id, user_id ?? null);
  await removeCoverFile(removed?.cover_path);
  return null;
};

/**
 * Stores a custom cover beside the cached thumbnails. The declared type must match the
 * file's own signature, so a renamed file or a non-image never reaches the folder.
 */
const uploadCover = async (manga_id: string, body: UploadMangaCoverBody, user_id?: string) => {
  const manga = await requireManga(manga_id);
  const image = Buffer.from(body.data, 'base64');
  if (image.length > MANGA_COVER_MAX_BYTES) {
    throw new PayloadTooLargeError('Covers can be at most 5 MB');
  }
  const detected = detectRasterImageType(image);
  if (!detected) throw new ValidationError('That file is not a supported image');
  if (detected !== body.mime) {
    throw new ValidationError('The file does not match its declared image type');
  }

  const cover_path = await storage.uploadBuffer(
    image,
    `${crypto.randomUUID()}.${extensionByType[detected]}`,
  );
  let result;
  try {
    result = await mangaOverrideRepository.upsert(manga.id, user_id ?? null, { cover_path });
  } catch (error) {
    await removeCoverFile(cover_path);
    throw error;
  }
  await removeCoverFile(result.previous?.cover_path);
  return toView(result.current);
};

/** Goes back to the source's cover, keeping any other edits. */
const removeCover = async (manga_id: string, user_id?: string) => {
  const manga = await requireManga(manga_id);
  const { previous, current } = await mangaOverrideRepository.upsert(manga.id, user_id ?? null, {
    cover_path: null,
  });
  await removeCoverFile(previous?.cover_path);
  return toView(current);
};

/** The file behind this identity's custom cover, or null to fall back to the cached one. */
/** This identity's custom cover: the file, and the version clients put in its URL
 * (`custom-<updated_at>`, see apps/web/src/lib/manga-data.ts). */
const getCoverFile = async (manga_id: string, user_id?: string) => {
  const row = await mangaOverrideRepository.find(manga_id, user_id ?? null);
  return row?.cover_path
    ? {
        path: storage.resolveCachedThumbnail(row.cover_path),
        version: `custom-${row.updated_at.toISOString()}`,
      }
    : null;
};

const mangaOverrideService = {
  updateOverride,
  resetOverride,
  uploadCover,
  removeCover,
  getCoverFile,
};

export default mangaOverrideService;
