import { resizedThumbnail, thumbnailWidth } from '../utils/thumbnailResize.js';
import { Request, Response, NextFunction } from 'express';
import fs from 'node:fs/promises';
import { HTTPSuccessResponse } from '../utils/responseHandlers.js';
import mangaRepository from '../repositories/manga.repository.js';
import cacheRepository from '../repositories/cache.repository.js';
import cacheService from '../services/cache.service.js';
import storage from '../utils/storage.js';
import { MangaNotFoundError, NotFoundError } from '../utils/customErrors.js';
import type { TriggerSyncBody } from '@projekt-manga/schemas';
import sourceService from '../services/source.service.js';
import mangaOverrideService from '../services/mangaOverride.service.js';

const triggerSync = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { manga_id } = req.params as { manga_id: string };
    const { source_thumbnail_url, sourceThumbnailUrl } = req.validated as TriggerSyncBody;
    const requestedThumbnailUrl = source_thumbnail_url || sourceThumbnailUrl;

    const manga = await mangaRepository.getMangaById(manga_id);
    if (!manga) throw new MangaNotFoundError('Manga not found');

    // A user-triggered refresh rechecks the source even if a cached copy exists.
    const result = await cacheService.syncThumbnail(
      manga.id,
      requestedThumbnailUrl || manga.thumbnail_url,
      {
        initiatedByUser: true,
        force: true,
      },
    );

    return HTTPSuccessResponse(res, 200, 'Cache sync triggered', result);
  } catch (error) {
    return next(error);
  }
};

const getStatus = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { manga_id } = req.params as { manga_id: string };
    const cache = await cacheRepository.findByMangaId(manga_id);

    return HTTPSuccessResponse(res, 200, 'Cache status retrieved', {
      exists: !!cache,
      manga_id,
      thumbnail_url: cache?.thumbnail_url
        ? `/api/cache/thumbnail/${encodeURIComponent(manga_id)}`
        : '',
      sha256_url: cache?.sha256_url ?? '',
    });
  } catch (error) {
    return next(error);
  }
};

/**
 * A cover may be cached briefly only when the URL's version names the image being sent:
 * `v=custom-…` for a custom cover, any other `v` for the source's. An unversioned URL
 * (History, Recents) or one naming the other kind is revalidated every time, so changing
 * or removing a custom cover never leaves the old image showing for minutes. The
 * revalidation is a cheap 304 when nothing changed (sendFile sends ETag/Last-Modified).
 */
export function coverCacheControl(req: Pick<Request, 'query'>, custom: boolean): string {
  const version = typeof req.query.v === 'string' ? req.query.v : '';
  const matches = custom
    ? version.startsWith('custom-')
    : !!version && !version.startsWith('custom-');
  return matches ? 'private, max-age=300' : 'private, no-cache';
}

const getThumbnail = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { manga_id } = req.params as { manga_id: string };
    const width = thumbnailWidth(req.query.w);
    // This identity's custom cover wins over the cached source one. Clients version the
    // URL by the override's updated_at, so the short private cache never shows a stale one.
    let customCover: string | null = null;
    try {
      customCover = await mangaOverrideService.getCoverFile(manga_id, req.user?.id);
      if (customCover) await fs.access(customCover);
    } catch {
      if (customCover) console.warn('Custom cover unavailable; using source cover', manga_id);
      customCover = null;
    }
    if (customCover) {
      res.setHeader('Cache-Control', coverCacheControl(req, true));
      const sized = width ? await resizedThumbnail(customCover, width) : customCover;
      return res.sendFile(sized, (error) => {
        if (error) next(error);
      });
    }
    const cache = await cacheRepository.findByMangaId(manga_id);
    if (cache?.thumbnail_url) {
      let file: string | null = null;
      try {
        file = storage.resolveCachedThumbnail(cache.thumbnail_url);
        await fs.access(file);
      } catch {
        file = null;
        // A stale cache row must not turn an otherwise valid source cover into a 404.
        console.warn('Cached thumbnail unavailable; using source cover', manga_id);
      }
      if (file) {
        res.setHeader('Cache-Control', coverCacheControl(req, false));
        const sized = width ? await resizedThumbnail(file, width) : file;
        return res.sendFile(sized, (error) => {
          if (error) next(error);
        });
      }
    }

    const manga = await mangaRepository.getMangaById(manga_id);
    if (!manga) {
      throw new NotFoundError('Thumbnail not found');
    }
    let sourceUrl = manga.thumbnail_url;
    // Old releases stored a public-folder path in the manga row. Those files are no longer
    // shipped with the server, so recover the cover from the installed source on demand.
    if (sourceUrl.startsWith('/extension/thumbnails/')) {
      sourceUrl = await sourceService.getMangaThumbnail(manga.source, manga.slug);
    }
    if (!/^https?:\/\//i.test(sourceUrl)) throw new NotFoundError('Thumbnail not found');
    const query = new URLSearchParams({ url: sourceUrl, source_id: manga.source });
    return res.redirect(302, `/api/source/image-proxy?${query}`);
  } catch (error) {
    return next(error);
  }
};

const getLegacyThumbnail = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { source_id, manga_id } = req.params as { source_id: string; manga_id: string };
    if (!source_id || !manga_id || source_id.length > 128 || manga_id.length > 512) {
      throw new NotFoundError('Thumbnail not found');
    }
    const sourceUrl = await sourceService.getMangaThumbnail(source_id, manga_id);
    if (!/^https?:\/\//i.test(sourceUrl)) throw new NotFoundError('Thumbnail not found');
    const query = new URLSearchParams({ url: sourceUrl, source_id });
    return res.redirect(302, `/api/source/image-proxy?${query}`);
  } catch (error) {
    return next(error);
  }
};

const cacheController = { triggerSync, getStatus, getThumbnail, getLegacyThumbnail };

export default cacheController;
