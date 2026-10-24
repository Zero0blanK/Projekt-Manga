import express from 'express';
import healthController from '../controllers/health.controller.js';
import { requireAuth } from '../middleware/auth.middleware.js';

const router = express.Router();

router.get('/', healthController.getLiveness);
// Unauthenticated like liveness: whatever supervises this process has no session. It
// discloses only whether the database answered.
router.get('/ready', healthController.getReadiness);
router.get('/diagnostics', healthController.getRecentDiagnostics);

// Scraper stats from apps/extensions: proxy health, ban/rate-limit counts, HTML cache hit rate.
router.get('/scraper', requireAuth, healthController.getScraperHealth);

export default router;
