import express from 'express';
import { previewBackupBodySchema, replaceBackupBodySchema } from '@projekt-manga/schemas';
import { validateBody } from '../middleware/validate.middleware.js';
import { requireAdmin } from '../middleware/admin.middleware.js';
import {
  cancelRestoreJob,
  getRestoreJob,
  previewRestoreJob,
  startRestoreJob,
} from '../controllers/restore.controller.js';

const router = express.Router();
router.use(requireAdmin);
router.post('/preview', validateBody(previewBackupBodySchema), previewRestoreJob);
router.post('/jobs', validateBody(replaceBackupBodySchema), startRestoreJob);
router.get('/jobs/:id', getRestoreJob);
router.delete('/jobs/:id', cancelRestoreJob);
export default router;
