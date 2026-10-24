import express from 'express';
import rateLimit from 'express-rate-limit';
import sourceController from '../controllers/source.controller.js';
import { validateQuery, validateBody } from '../middleware/validate.middleware.js';
import {
  sourceMangaQuerySchema,
  sourceSearchQuerySchema,
  sourceChapterPagesQuerySchema,
  imageProxyQuerySchema,
  fetchMangaUpdatesBodySchema,
  sourceCatalogueQuerySchema,
  sourceSearchPageQuerySchema,
} from '@projekt-manga/schemas';

const router = express.Router();

const hasImageUrl = (url: unknown) => typeof url === 'string' && url.trim().length > 0;

// Bad/missing requests should not consume the shared budget used by Next's cover loader.
const malformedImageProxyRateLimit = rateLimit({
  windowMs: 30 * 1000,
  limit: 60,
  skip: (req) => hasImageUrl(req.query.url),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many image requests — please try again shortly.' },
});

// Next's optimizer reaches this route from one server IP for many covers and users.
// Keep a relay ceiling while allowing browsing bursts and bounded image retries.
export const IMAGE_PROXY_REQUEST_LIMIT = 600;
const imageProxyRateLimit = rateLimit({
  windowMs: 30 * 1000,
  limit: IMAGE_PROXY_REQUEST_LIMIT,
  skip: (req) => !hasImageUrl(req.query.url),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many image requests — please try again shortly.' },
});

router.get(
  '/image-proxy',
  malformedImageProxyRateLimit,
  imageProxyRateLimit,
  validateQuery(imageProxyQuerySchema),
  sourceController.proxyImage,
);

router.get('/sources', sourceController.getSources);
router.get('/health', sourceController.getSourceHealth);
/**
 * Deliberately not behind requireAuth: an account is optional, so anonymous visitors must
 * be able to update their library. Each sweep scrapes an upstream source per library
 * title, so it needs a ceiling or it gets this app's IP blocked. The service also refuses
 * concurrent sweeps (see checkAllLibraryUpdates); this limits repeated polling of that.
 * The route is registered before `/:source_id/...` so "library" is never read as a source id.
 */
const librarySweepRateLimit = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Library updates were checked very recently — please wait a few minutes.',
  },
});

router.post('/library/check-updates', librarySweepRateLimit, sourceController.checkLibraryUpdates);
router.get('/:source_id/capabilities', sourceController.getCapabilities);
router.get(
  '/:source_id/catalogue',
  validateQuery(sourceCatalogueQuerySchema),
  sourceController.getCataloguePage,
);
router.get(
  '/:source_id/search-page',
  validateQuery(sourceSearchPageQuerySchema),
  sourceController.searchMangaPage,
);
router.get('/:source_id/manga', validateQuery(sourceMangaQuerySchema), sourceController.getManga);
router.get(
  '/:source_id/search',
  validateQuery(sourceSearchQuerySchema),
  sourceController.searchManga,
);
router.get('/:source_id/manga/:manga_id', sourceController.getMangaDetails);
router.get('/:source_id/manga/:manga_id/thumbnail', sourceController.getMangaThumbnail);
router.get(
  '/:source_id/chapter/:chapter_id/pages',
  validateQuery(sourceChapterPagesQuerySchema),
  sourceController.getChapterPages,
);
router.get('/:source_id/filters', sourceController.getFilters);
router.post(
  '/:source_id/manga/:manga_slug/updates',
  validateBody(fetchMangaUpdatesBodySchema),
  sourceController.fetchMangaUpdates,
);

export default router;
