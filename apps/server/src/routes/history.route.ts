import express from 'express';
import historyController from '../controllers/history.controller.js';
import { validateBody } from '../middleware/validate.middleware.js';
import { addHistoryBodySchema } from '@projekt-manga/schemas';

const router = express.Router();

router.get('/', historyController.getHistory);
router.post('/add', validateBody(addHistoryBodySchema), historyController.addHistory);
router.delete('/delete/:id', historyController.deleteHistory);
router.get('/:manga_slug', historyController.getHistoryByMangaSlug);

export default router;
