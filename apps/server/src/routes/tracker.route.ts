import express from 'express';
import trackerController from '../controllers/tracker.controller.js';
import { validateQuery, validateBody } from '../middleware/validate.middleware.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import {
  trackerCallbackQuerySchema,
  trackerSearchQuerySchema,
  linkTrackerBodySchema,
} from '@projekt-manga/schemas';

const router = express.Router();

router.get('/', requireAuth, trackerController.listConnected);
// Declared before the /:tracker routes so "sync" is never read as a tracker name.
router.post('/sync', requireAuth, trackerController.syncNow);
router.get('/:tracker/authorize', requireAuth, trackerController.getAuthorizeUrl);
// No requireAuth on purpose: this is a full-page redirect from the tracker's site, so an
// unauthenticated user must be redirected rather than shown a bare 401. The handler
// checks req.user itself.
router.get(
  '/:tracker/callback',
  validateQuery(trackerCallbackQuerySchema),
  trackerController.handleCallback,
);
router.delete('/:tracker', requireAuth, trackerController.disconnect);
router.get(
  '/:tracker/search',
  requireAuth,
  validateQuery(trackerSearchQuerySchema),
  trackerController.searchMedia,
);

export default router;
