import express from 'express';
import mangaController from '../controllers/manga.controller.js';
import { validateBody, validateQuery } from '../middleware/validate.middleware.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import {
  getMangaQuerySchema,
  addMangaBodySchema,
  updateLibraryMembershipBodySchema,
  linkTrackerBodySchema,
  migrateMangaBodySchema,
} from '@projekt-manga/schemas';

const router = express.Router();

router.get('/', validateQuery(getMangaQuerySchema), mangaController.getManga);
router.get('/details/:manga_id', mangaController.getMangaDetailsById);
router.get('/:manga_id', mangaController.getMangaById);
router.post('/add', validateBody(addMangaBodySchema), mangaController.addManga);
// Fixed path, ordered before the `/:category_id/:manga_slug/add` catch-all so "library"
// is never read as a category id.
router.patch(
  '/:manga_id/library',
  validateBody(updateLibraryMembershipBodySchema),
  mangaController.setInLibrary,
);
// Fixed path, ordered before the `/:category_id/:manga_slug/add` catch-all like /library.
// Not requireAuth: an account is optional, and the service migrates the shared rows when
// there isn't one.
router.post(
  '/:manga_id/migrate',
  validateBody(migrateMangaBodySchema),
  mangaController.migrateManga,
);
// Tracker linking is account-only (a tracker connection belongs to one signed-in
// person, never the shared anonymous identity).
router.get('/:manga_id/tracker-link', requireAuth, mangaController.getTrackerLinks);
router.post(
  '/:manga_id/tracker-link',
  requireAuth,
  validateBody(linkTrackerBodySchema),
  mangaController.linkTracker,
);
router.delete('/:manga_id/tracker-link/:tracker', requireAuth, mangaController.unlinkTracker);
router.post('/:category_id/:manga_slug/add', mangaController.addMangaToCategory);
router.delete('/:manga_id/delete', mangaController.deleteManga);
router.get(
  '/category/:category_id',
  validateQuery(getMangaQuerySchema),
  mangaController.getMangaByCategoryId,
);

export default router;
