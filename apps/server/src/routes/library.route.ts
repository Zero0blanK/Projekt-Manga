import express from 'express';
import libraryController from '../controllers/library.controller.js';
import { validateBody } from '../middleware/validate.middleware.js';
import { updateLibraryStateBodySchema } from '@projekt-manga/schemas';

const router = express.Router();

router.get('/', libraryController.getLibraryState);
// Before `/:manga_id` routes so the path is never read as a manga id.
router.get('/release-estimates', libraryController.getReleaseEstimates);
router.patch(
  '/:manga_id',
  validateBody(updateLibraryStateBodySchema),
  libraryController.updateLibraryState,
);

export default router;
