import express from 'express';
import updateLogController from '../controllers/updateLog.controller.js';
import { validateQuery } from '../middleware/validate.middleware.js';
import { updateLogQuerySchema } from '@projekt-manga/schemas';

const router = express.Router();

router.get('/', validateQuery(updateLogQuerySchema), updateLogController.getRecent);

export default router;
