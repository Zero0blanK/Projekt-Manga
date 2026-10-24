import express from 'express';
import cacheController from '../controllers/cache.controller.js';
import { validateBody } from '../middleware/validate.middleware.js';
import { triggerSyncBodySchema } from '@projekt-manga/schemas';

const router = express.Router();

router.post('/sync/:manga_id', validateBody(triggerSyncBodySchema), cacheController.triggerSync);
router.get('/status/:manga_id', cacheController.getStatus);
router.get('/legacy-thumbnail/:source_id/:manga_id', cacheController.getLegacyThumbnail);
router.get('/thumbnail/:manga_id', cacheController.getThumbnail);

export default router;
