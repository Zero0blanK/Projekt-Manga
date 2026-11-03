import express from 'express';
import {
  suwayomiExtensionActionBodySchema,
  suwayomiSettingsBodySchema,
} from '@projekt-manga/schemas';
import { validateBody } from '../middleware/validate.middleware.js';
import { requireAdmin } from '../middleware/admin.middleware.js';
import {
  changeExtension,
  deleteSettings,
  getExtensions,
  getSettings,
  putSettings,
  testConnection,
} from '../controllers/suwayomi.controller.js';

/** Which Suwayomi server supplies sources is a host-level setting, so it gets the same
 * admission as installing extension code. */
const router = express.Router();
router.use(requireAdmin);
router.get('/settings', getSettings);
router.put('/settings', validateBody(suwayomiSettingsBodySchema), putSettings);
router.delete('/settings', deleteSettings);
router.post('/test', testConnection);
router.get('/extensions', getExtensions);
router.post(
  '/extensions/:pkg_name',
  validateBody(suwayomiExtensionActionBodySchema),
  changeExtension,
);
export default router;
