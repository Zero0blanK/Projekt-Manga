import express from 'express';
import rateLimit from 'express-rate-limit';
import trackerController from '../controllers/tracker.controller.js';
import { validateQuery, validateBody } from '../middleware/validate.middleware.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import {
  trackerCallbackQuerySchema,
  trackerSearchQuerySchema,
  linkTrackerBodySchema,
  connectTrackerBodySchema,
} from '@projekt-manga/schemas';

const router = express.Router();

// The credential connect forwards a password or API key to a third-party service (or a
// reader-chosen server), so it's capped like this app's own login: it must not become a
// way to brute-force someone's tracker account, or to probe hosts in a tight loop.
const connectRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many attempts — please wait and try again.' },
});

router.get('/', requireAuth, trackerController.listConnected);
// Declared before the /:tracker routes so "sync" is never read as a tracker name.
router.post('/sync', requireAuth, trackerController.syncNow);
router.get('/available', requireAuth, trackerController.listAvailable);
router.get('/:tracker/authorize', requireAuth, trackerController.getAuthorizeUrl);
// No requireAuth on purpose: this is a full-page redirect from the tracker's site, so an
// unauthenticated user must be redirected rather than shown a bare 401. The handler
// checks req.user itself.
router.get(
  '/:tracker/callback',
  validateQuery(trackerCallbackQuerySchema),
  trackerController.handleCallback,
);
router.post(
  '/:tracker/connect',
  requireAuth,
  connectRateLimit,
  validateBody(connectTrackerBodySchema),
  trackerController.connectWithCredentials,
);
router.delete('/:tracker', requireAuth, trackerController.disconnect);
router.get(
  '/:tracker/search',
  requireAuth,
  validateQuery(trackerSearchQuerySchema),
  trackerController.searchMedia,
);

export default router;
