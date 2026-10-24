import axios from 'axios';
import crypto from 'crypto';
import type { Readable } from 'node:stream';
import cacheRepository from '../repositories/cache.repository.js';
import storage from '../utils/storage.js';
import { createImageRequestHeaders } from '../utils/userAgent.js';
import {
  assertPublicHttpUrl,
  isDisallowedRedirectHost,
  guardedHttpAgent,
  guardedHttpsAgent,
} from '../utils/ssrfGuard.js';
import { MAX_IMAGE_BYTES, detectRasterImageType } from '../utils/imageContent.js';
import {
  PayloadTooLargeError,
  UpstreamError,
  ValidationError,
  rethrowKnownOrWrap,
} from '../utils/customErrors.js';

const downloadImage = async (url: string) => {
  await assertPublicHttpUrl(url);
  const res = await axios.get(url, {
    responseType: 'stream',
    timeout: 15000,
    headers: createImageRequestHeaders(),
    // Validates the address every hop actually connects to, which beforeRedirect
    // (hostname only) and a pre-flight DNS check (TOCTOU) both miss.
    httpAgent: guardedHttpAgent,
    httpsAgent: guardedHttpsAgent,
    beforeRedirect: (options) => {
      if (isDisallowedRedirectHost(String(options.hostname))) {
        throw new Error('Redirect target is disallowed');
      }
    },
  });
  const stream = res.data as Readable;

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > MAX_IMAGE_BYTES) {
      stream.destroy();
      throw new PayloadTooLargeError('Image response is too large');
    }
    chunks.push(bytes);
  }
  const image = Buffer.concat(chunks, size);
  const imageType = detectRasterImageType(image);
  if (!imageType) {
    throw new UpstreamError('The source did not return a valid image');
  }
  return { image, imageType };
};

const computeSha = (buf: Buffer) => {
  return crypto.createHash('sha256').update(buf).digest('hex');
};

const extensionByType: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
};

const syncThumbnailUnlocked = async (
  manga_id: string,
  source_url?: string | null,
  options?: { initiatedByUser?: boolean; force?: boolean },
) => {
  // Only an absolute http(s) source can be fetched. Rows pointing at a local cache path
  // would otherwise be retried forever against a path that is not a URL.
  if (!source_url || !/^https?:\/\//i.test(source_url)) {
    if (options?.initiatedByUser) throw new ValidationError('A source thumbnail URL is required');
    return { updated: false };
  }
  try {
    const existing = await cacheRepository.findByMangaId(manga_id);

    if (existing && !options?.force) {
      return { updated: false };
    }

    const { image, imageType } = await downloadImage(source_url);
    const sha = computeSha(image);

    // Double-check: if cache already exists with same SHA (race condition), skip
    if (existing?.sha256_url === sha) {
      return { updated: false };
    }

    const ext = extensionByType[imageType];
    const key = `${crypto.randomUUID()}.${ext}`;
    const hostedUrl = await storage.uploadBuffer(image, key);

    try {
      await cacheRepository.upsertByMangaId(manga_id, hostedUrl, sha);
    } catch (error) {
      await storage.removeCachedThumbnail(hostedUrl).catch((cleanupError) => {
        console.error('Failed to clean up unused thumbnail', cleanupError);
      });
      throw error;
    }
    if (existing?.thumbnail_url) {
      await storage.removeCachedThumbnail(existing.thumbnail_url).catch((error) => {
        console.error('Failed to clean up replaced thumbnail', error);
      });
    }

    return { updated: true, hostedUrl: `/api/cache/thumbnail/${encodeURIComponent(manga_id)}` };
  } catch (error) {
    console.error('cache.service.syncThumbnail error', error);
    if (options?.initiatedByUser) {
      rethrowKnownOrWrap(error, new UpstreamError('Thumbnail cache refresh failed'));
    }
    return { updated: false };
  }
};

const pendingByManga = new Map<string, Promise<void>>();

const pruneOrphanedThumbnails = async (): Promise<number> =>
  storage.pruneOrphanedThumbnails(await cacheRepository.listPrivateUrls());

const syncThumbnail = async (
  manga_id: string,
  source_url?: string | null,
  options?: { initiatedByUser?: boolean; force?: boolean },
) => {
  const previous = pendingByManga.get(manga_id);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  pendingByManga.set(manga_id, pending);
  if (previous) await previous;
  try {
    return await syncThumbnailUnlocked(manga_id, source_url, options);
  } finally {
    release();
    if (pendingByManga.get(manga_id) === pending) pendingByManga.delete(manga_id);
  }
};

const cacheService = { syncThumbnail, pruneOrphanedThumbnails };

export default cacheService;
