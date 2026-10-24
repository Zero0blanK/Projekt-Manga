import express from 'express';
import extensionRepositoryController from '../controllers/extensionRepository.controller.js';
import { validateBody } from '../middleware/validate.middleware.js';
import { requireAdmin } from '../middleware/admin.middleware.js';
import {
  addExtensionRepositoryBodySchema,
  installExtensionBodySchema,
} from '@projekt-manga/schemas';

const router = express.Router();

router.get('/repositories', extensionRepositoryController.listRepositories);
router.post(
  '/repositories',
  requireAdmin,
  validateBody(addExtensionRepositoryBodySchema),
  extensionRepositoryController.addRepository,
);
router.post('/repositories/:id/refresh', requireAdmin, extensionRepositoryController.refreshRepository);
router.delete('/repositories/:id', requireAdmin, extensionRepositoryController.deleteRepository);

router.get('/installed', extensionRepositoryController.listInstalledExtensions);
router.post(
  '/installed',
  requireAdmin,
  validateBody(installExtensionBodySchema),
  extensionRepositoryController.installExtension,
);
router.post('/installed/:id/update', requireAdmin, extensionRepositoryController.updateInstalledExtension);
router.delete('/installed/:id', requireAdmin, extensionRepositoryController.deleteInstalledExtension);

export default router;
