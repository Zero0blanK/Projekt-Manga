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
  updateMangaOverrideBodySchema,
  uploadMangaCoverBodySchema,
  createMangaLinkBodySchema,
  reorderMangaLinksBodySchema,
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
// Local edits (title, author, description, status, cover) over the shared catalog. Not
// requireAuth: anonymous use edits its own overlay row, like migrate above.
router.patch(
  '/:manga_id/override',
  validateBody(updateMangaOverrideBodySchema),
  mangaController.updateOverride,
);
router.delete('/:manga_id/override', mangaController.resetOverride);
// Linked sources (other sources' copies of a title). Per identity like overrides; two path
// segments, so `/links/all` never meets the `/:manga_id` route above.
router.get('/links/all', mangaController.getAllLinks);
router.get('/:manga_id/links', mangaController.getLinks);
router.post(
  '/:manga_id/links',
  validateBody(createMangaLinkBodySchema),
  mangaController.createLink,
);
router.put(
  '/:manga_id/links/order',
  validateBody(reorderMangaLinksBodySchema),
  mangaController.reorderLinks,
);
router.delete('/:manga_id/links/:link_id', mangaController.removeLink);
// The body limit for this path is raised in app.ts, ahead of the global JSON parser.
router.post(
  '/:manga_id/override/cover',
  validateBody(uploadMangaCoverBodySchema),
  mangaController.uploadCover,
);
router.delete('/:manga_id/override/cover', mangaController.removeCover);
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
