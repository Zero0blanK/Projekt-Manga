import express from 'express';
import historyController from '../controllers/history.controller.js';
import { validateBody, validateQuery } from '../middleware/validate.middleware.js';
import { addHistoryBodySchema, listPageQuerySchema } from '@projekt-manga/schemas';

const router = express.Router();

router.get('/', validateQuery(listPageQuerySchema), historyController.getHistory);
router.post('/add', validateBody(addHistoryBodySchema), historyController.addHistory);
router.delete('/delete/:id', historyController.deleteHistory);
router.get('/:manga_slug', historyController.getHistoryByMangaSlug);

export default router;
