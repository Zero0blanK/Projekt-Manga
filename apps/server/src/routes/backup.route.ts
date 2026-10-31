import express from 'express';
import { updateBackupConfigBodySchema } from '@projekt-manga/schemas';
import { validateBody } from '../middleware/validate.middleware.js';
import { requireAdmin } from '../middleware/admin.middleware.js';
import {
  backupNow,
  backupStatus,
  downloadBackupFile,
  exportBackup,
  patchBackupConfig,
} from '../controllers/backup.controller.js';

/** Backups are full copies of reading history, so they get the same admission as restore:
 * host-level (requireAdmin) and scoped to the requesting session's owner. */
const router = express.Router();
router.use(requireAdmin);
router.get('/export', exportBackup);
router.get('/', backupStatus);
router.post('/', backupNow);
router.get('/files/:name', downloadBackupFile);
router.patch('/config', validateBody(updateBackupConfigBodySchema), patchBackupConfig);
export default router;
