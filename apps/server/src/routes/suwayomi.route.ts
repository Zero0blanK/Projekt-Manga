import express from 'express';
import {
  suwayomiEngineRemoveQuerySchema,
  suwayomiEngineRepositoriesBodySchema,
  suwayomiEngineSettingsBodySchema,
  suwayomiExtensionActionBodySchema,
  suwayomiModeBodySchema,
  suwayomiSettingsBodySchema,
} from '@projekt-manga/schemas';
import { validateBody, validateQuery } from '../middleware/validate.middleware.js';
import {
  cancelDownload,
  checkUpdates,
  getEngine,
  getRepositories,
  installEngine,
  putEngineSettings,
  putMode,
  putRepositories,
  removeEngine,
  startEngine,
  stopEngine,
  updateEngine,
} from '../controllers/suwayomiEngine.controller.js';
import { requireAdmin } from '../middleware/admin.middleware.js';
import {
  changeExtension,
  deleteSettings,
  getExtensions,
  importLibrary,
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
router.post('/import', importLibrary);
router.get('/extensions', getExtensions);
router.post(
  '/extensions/:pkg_name',
  validateBody(suwayomiExtensionActionBodySchema),
  changeExtension,
);

// Where Suwayomi sources come from: the built-in engine, the user's own server, or off.
router.put('/mode', validateBody(suwayomiModeBodySchema), putMode);

// The built-in extension engine.
router.get('/engine', getEngine);
router.post('/engine/install', installEngine);
router.post('/engine/update', updateEngine);
router.post('/engine/cancel', cancelDownload);
router.post('/engine/check-updates', checkUpdates);
router.post('/engine/start', startEngine);
router.post('/engine/stop', stopEngine);
router.delete('/engine', validateQuery(suwayomiEngineRemoveQuerySchema), removeEngine);
router.put('/engine/settings', validateBody(suwayomiEngineSettingsBodySchema), putEngineSettings);
router.get('/engine/repositories', getRepositories);
router.put(
  '/engine/repositories',
  validateBody(suwayomiEngineRepositoriesBodySchema),
  putRepositories,
);
export default router;
