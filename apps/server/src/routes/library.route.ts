import express from 'express';
import libraryController from '../controllers/library.controller.js';
import { validateBody } from '../middleware/validate.middleware.js';
import { updateLibraryStateBodySchema } from '@projekt-manga/schemas';

const router = express.Router();

router.get('/', libraryController.getLibraryState);
router.patch(
  '/:manga_id',
  validateBody(updateLibraryStateBodySchema),
  libraryController.updateLibraryState,
);

export default router;
