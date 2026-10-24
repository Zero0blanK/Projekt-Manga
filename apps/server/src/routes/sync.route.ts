import express from 'express';
import syncController from '../controllers/sync.controller.js';
import { validateBody, validateQuery } from '../middleware/validate.middleware.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { syncPullQuerySchema, syncPushBodySchema } from '@projekt-manga/schemas';

const router = express.Router();

router.get('/generation', requireAuth, syncController.generation);
router.get('/pull', requireAuth, validateQuery(syncPullQuerySchema), syncController.pull);
router.post('/push', requireAuth, validateBody(syncPushBodySchema), syncController.push);

export default router;
