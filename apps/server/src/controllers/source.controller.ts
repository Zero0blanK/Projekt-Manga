import { Request, Response, NextFunction } from 'express';
import axios from 'axios';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { HTTPErrorResponse, HTTPSuccessResponse } from '../utils/responseHandlers.js';
import sourceService from '../services/source.service.js';
import { getSourceHealthSnapshot } from '../services/sourceHealth.service.js';
import type { FilterValue } from '@projekt-manga/types';
import type {
  SourceMangaQuery,
  SourceSearchQuery,
  SourceChapterPagesQuery,
  ImageProxyQuery,
  FetchMangaUpdatesBody,
  SourceCatalogueQuery,
  SourceSearchPageQuery,
} from '@projekt-manga/schemas';
import { createImageRequestHeaders, hasImageReferer } from '../utils/userAgent.js';
import extensionRepository from '../repositories/extensionRepository.repository.js';
import {
  assertPublicHttpUrl,
  isDisallowedRedirectHost,
  guardedHttpAgent,
  guardedHttpsAgent,
  freshGuardedAgents,
} from '../utils/ssrfGuard.js';
import { HostLimiter } from '../utils/hostLimiter.js';
import { ValidationError } from '../utils/customErrors.js';
import { createByteLimitStream } from '../utils/byteLimitStream.js';
import { MAX_IMAGE_BYTES, detectRasterImageType } from '../utils/imageContent.js';

/** Covers high-resolution manga covers without allowing the image proxy to become an
 * unbounded bandwidth relay. The streamed check below also covers chunked responses. */
export const MAX_PROXY_IMAGE_BYTES = MAX_IMAGE_BYTES;

function parseContentLength(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

/** Upstream answers worth one retry on a fresh connection (see the proxy below). */
// Not 429: that is an explicit "slow down" with its own Retry-After, passed on below.
const RETRYABLE_UPSTREAM_STATUSES = new Set([403, 503]);
const UPSTREAM_RETRY_DELAY_MS = 300;
/** Concurrent image requests allowed per upstream host. */
const imageProxyLimiter = new HostLimiter(4);

/** The installed source's own site, as a Referer for a retried image request. */
async function sourceReferer(sourceId: string): Promise<Record<string, string>> {
  if (!sourceId || hasImageReferer(sourceId)) return {};
  try {
    const installed = (await extensionRepository.getInstalledExtensions()).find(
      (row) => row.source_key === sourceId,
    );
    const site = installed?.homepage || installed?.base_url;
    return site ? { Referer: `${new URL(site).origin}/` } : {};
  } catch {
    return {};
  }
}

/** A 1×1 transparent PNG: what an <img> receives when the proxy can't deliver a page. */
const TRANSPARENT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

/**
 * Error answer for the image proxy. Browsers load it from <img>, and a JSON error body
 * there is blocked outright (ERR_BLOCKED_BY_ORB) instead of reaching onerror cleanly, so
 * image requests get an image body with the error status and the reason in a header.
 * API clients still get the JSON envelope.
 */
function proxyError(req: Request, res: Response, status: number, message: string) {
  if (req.get('sec-fetch-dest') === 'image') {
    res.setHeader('X-Proxy-Error', message);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(status).type('image/png').send(TRANSPARENT_PNG);
  }
  return HTTPErrorResponse(res, status, message);
}

const parseFilters = (raw: string | undefined): Record<string, FilterValue> => {
  if (!raw) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ValidationError('Invalid filters query JSON');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ValidationError('Invalid filters query JSON');
  }

  return parsed as Record<string, FilterValue>;
};

const getSources = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const sources = await sourceService.getSources();
    return HTTPSuccessResponse(res, 200, 'Sources retrieved successfully', sources);
  } catch (error) {
    next(error);
  }
};

const getSourceHealth = (_req: Request, res: Response) =>
  HTTPSuccessResponse(res, 200, 'Source health retrieved', getSourceHealthSnapshot());

const getCapabilities = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { source_id } = req.params as { source_id: string };
    return HTTPSuccessResponse(
      res,
      200,
      'Source capabilities retrieved',
      await sourceService.getCapabilities(source_id),
    );
  } catch (error) {
    next(error);
  }
};

const cataloguePage =
  (search: boolean) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { source_id } = req.params as { source_id: string };
      const validated = req.validated as SourceCatalogueQuery & SourceSearchPageQuery;
      const page = await sourceService.getCataloguePage(
        {
          sourceId: source_id,
          category: validated.category ?? 'latest',
          query: validated.query ?? '',
          pagination: { cursor: validated.cursor, limit: validated.limit ?? 20 },
          filters: parseFilters(validated.filters),
        },
        search,
      );
      return HTTPSuccessResponse(res, 200, 'Source catalogue retrieved', page);
    } catch (error) {
      next(error);
    }
  };
const getCataloguePage = cataloguePage(false);
const searchMangaPage = cataloguePage(true);

const getManga = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { source_id } = req.params as { source_id: string };
    const { category, limit, offset, filters } = req.validated as SourceMangaQuery;

    const manga = await sourceService.getManga({
      sourceId: source_id,
      category: category ?? 'latest',
      pagination: { limit: limit ?? 20, offset: offset ?? 0 },
      filters: parseFilters(filters),
    });
    return HTTPSuccessResponse(res, 200, 'Manga retrieved successfully', manga);
  } catch (error) {
    next(error);
  }
};

const searchManga = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { source_id } = req.params as { source_id: string };
    const { query, limit, offset, filters } = req.validated as SourceSearchQuery;

    const results = await sourceService.searchManga({
      sourceId: source_id,
      query: query ?? '',
      pagination: { limit: limit ?? 20, offset: offset ?? 0 },
      filters: parseFilters(filters),
    });

    return HTTPSuccessResponse(res, 200, 'Manga search completed successfully', results);
  } catch (error) {
    next(error);
  }
};

const getMangaDetails = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { source_id, manga_id } = req.params as { source_id: string; manga_id: string };
    const details = await sourceService.getMangaDetails(source_id, manga_id);
    return HTTPSuccessResponse(res, 200, 'Manga details retrieved successfully', details);
  } catch (error) {
    next(error);
  }
};

const getMangaThumbnail = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { source_id, manga_id } = req.params as { source_id: string; manga_id: string };
    const thumbnail_url = await sourceService.getMangaThumbnail(source_id, manga_id);
    return HTTPSuccessResponse(res, 200, 'Manga thumbnail retrieved successfully', {
      thumbnail_url,
    });
  } catch (error) {
    next(error);
  }
};

const getChapterPages = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { source_id, chapter_id } = req.params as { source_id: string; chapter_id: string };
    const { manga_slug, limit, offset } = req.validated as SourceChapterPagesQuery;

    const pages = await sourceService.getChapterPages(source_id, chapter_id, manga_slug, {
      limit: limit ?? 100,
      offset: offset ?? 0,
    });
    return HTTPSuccessResponse(res, 200, 'Chapter pages retrieved successfully', pages);
  } catch (error) {
    next(error);
  }
};

const getFilters = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { source_id } = req.params as { source_id: string };
    const filters = await sourceService.getFilters(source_id);
    return HTTPSuccessResponse(res, 200, 'Filters retrieved successfully', filters);
  } catch (error) {
    next(error);
  }
};

const fetchMangaUpdates = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { source_id, manga_slug } = req.params as { source_id: string; manga_slug: string };
    const { manga_id, mangaId } = req.validated as FetchMangaUpdatesBody;
    const resolvedMangaId = manga_id || mangaId || undefined;
    const result = await sourceService.fetchMangaUpdates(source_id, manga_slug, resolvedMangaId);
    return HTTPSuccessResponse(
      res,
      200,
      result.failed ? 'Manga update check failed' : 'Manga updates fetched successfully',
      result,
    );
  } catch (error) {
    next(error);
  }
};

const checkLibraryUpdates = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await sourceService.checkAllLibraryUpdates();
    return HTTPSuccessResponse(res, 200, 'Library updates checked successfully', result);
  } catch (error) {
    next(error);
  }
};

const proxyImage = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { url, source_id } = req.validated as ImageProxyQuery;
    const targetUrl = url.trim();
    const sourceId = source_id?.trim().toLowerCase() ?? '';

    try {
      await assertPublicHttpUrl(targetUrl);
    } catch {
      return proxyError(req, res, 400, 'Invalid or disallowed url');
    }

    // Held until the image has been streamed out, so the cap covers the whole transfer.
    return await imageProxyLimiter.run(new URL(targetUrl).hostname, async () => {
      const requestUpstream = (fresh: boolean, extraHeaders: Record<string, string> = {}) =>
        axios.get(targetUrl, {
          responseType: 'stream',
          timeout: 30000,
          headers: createImageRequestHeaders(sourceId, extraHeaders),
          validateStatus: () => true,
          // Validates the address every hop actually connects to, which beforeRedirect
          // (hostname only) and a pre-flight DNS check (TOCTOU) both miss.
          ...(fresh
            ? freshGuardedAgents()
            : { httpAgent: guardedHttpAgent, httpsAgent: guardedHttpsAgent }),
          beforeRedirect: (options) => {
            if (isDisallowedRedirectHost(String(options.hostname))) {
              throw new Error('Redirect target is disallowed');
            }
          },
        });

      let upstream = await requestUpstream(false);
      // A CDN that has started refusing the pooled connection keeps refusing it; one retry
      // on a brand-new connection, after a short pause, is usually accepted.
      if (RETRYABLE_UPSTREAM_STATUSES.has(upstream.status)) {
        (upstream.data as Readable).destroy();
        await new Promise((resolve) => setTimeout(resolve, UPSTREAM_RETRY_DELAY_MS));
        // Many image CDNs only serve hotlinks that come from their own site, so the retry
        // also presents the installed source's site as the Referer when the server has no
        // hand-tuned Referer for it.
        upstream = await requestUpstream(true, await sourceReferer(sourceId));
      }

      const contentLength = upstream.headers['content-length'];
      const cacheControl = upstream.headers['cache-control'];
      const etag = upstream.headers.etag;
      const lastModified = upstream.headers['last-modified'];

      if (upstream.status < 200 || upstream.status >= 300) {
        upstream.data.destroy();
        if (upstream.status === 429) {
          const retryAfter = upstream.headers['retry-after'];
          if (typeof retryAfter === 'string' && /^\d{1,3}$/.test(retryAfter)) {
            res.setHeader('Retry-After', retryAfter);
          }
          return proxyError(
            req,
            res,
            429,
            'The image source is temporarily rate-limiting requests',
          );
        }
        return proxyError(req, res, 502, 'The source did not return a supported image');
      }

      if ((parseContentLength(contentLength) ?? 0) > MAX_PROXY_IMAGE_BYTES) {
        upstream.data.destroy();
        return proxyError(req, res, 413, 'Image response is too large');
      }

      // Verify the bytes before responding: the upstream Content-Type is attacker-controlled.
      const upstreamStream = upstream.data as Readable;
      const iterator = upstreamStream[Symbol.asyncIterator]();
      const prefixChunks: Buffer[] = [];
      let prefixSize = 0;
      while (prefixSize < 32) {
        const part = await iterator.next();
        if (part.done) break;
        const bytes = Buffer.isBuffer(part.value)
          ? part.value
          : Buffer.from(part.value as Uint8Array);
        prefixSize += bytes.length;
        if (prefixSize > MAX_PROXY_IMAGE_BYTES) {
          upstreamStream.destroy();
          return proxyError(req, res, 413, 'Image response is too large');
        }
        prefixChunks.push(bytes);
      }
      const contentType = detectRasterImageType(Buffer.concat(prefixChunks, prefixSize));
      if (!contentType) {
        upstreamStream.destroy();
        return proxyError(req, res, 502, 'The source did not return a valid image');
      }

      const imageBody = Readable.from(
        (async function* () {
          try {
            yield* prefixChunks;
            for (;;) {
              const part = await iterator.next();
              if (part.done) break;
              yield part.value;
            }
          } finally {
            await iterator.return?.();
          }
        })(),
      );

      // Never reflect a remote HTML/SVG response onto the API's authenticated origin.
      res.setHeader('Content-Type', contentType);
      if (
        typeof contentLength === 'string' ||
        typeof contentLength === 'number' ||
        Array.isArray(contentLength)
      ) {
        res.setHeader('Content-Length', contentLength);
      }
      if (
        typeof cacheControl === 'string' ||
        typeof cacheControl === 'number' ||
        Array.isArray(cacheControl)
      ) {
        res.setHeader('Cache-Control', cacheControl);
      }
      if (typeof etag === 'string' || typeof etag === 'number' || Array.isArray(etag)) {
        res.setHeader('ETag', etag);
      }
      if (
        typeof lastModified === 'string' ||
        typeof lastModified === 'number' ||
        Array.isArray(lastModified)
      ) {
        res.setHeader('Last-Modified', lastModified);
      }

      res.status(upstream.status);
      await pipeline(
        imageBody,
        createByteLimitStream(MAX_PROXY_IMAGE_BYTES, 'Image response is too large'),
        res,
      );
    });
  } catch (error) {
    next(error);
  }
};

const sourceController = {
  getCapabilities,
  getCataloguePage,
  searchMangaPage,
  getSources,
  getSourceHealth,
  getManga,
  searchManga,
  getMangaDetails,
  getMangaThumbnail,
  getChapterPages,
  getFilters,
  fetchMangaUpdates,
  checkLibraryUpdates,
  proxyImage,
};

export default sourceController;
