import express from 'express';
import chapterController from '../controllers/chapter.controller.js';
import { validateBody } from '../middleware/validate.middleware.js';
import {
  chapterMetaSchema,
  chaptersBulkBodySchema,
  addChapterAsHistoryBodySchema,
} from '@projekt-manga/schemas';

const router = express.Router();

router.post(
  '/:manga_slug/:chapter_id/mark-read',
  validateBody(chapterMetaSchema),
  chapterController.markChapterAsRead,
);
router.post(
  '/:manga_slug/:chapter_id/mark-unread',
  validateBody(chapterMetaSchema),
  chapterController.markChapterAsUnread,
);
router.post(
  '/:manga_slug/:chapter_id/:last_page_read/mark-by-page',
  validateBody(chapterMetaSchema),
  chapterController.markChapterByLastPage,
);
router.post(
  '/:manga_slug/bulk-mark-read',
  validateBody(chaptersBulkBodySchema),
  chapterController.markPreviousChaptersAsRead,
);
router.post(
  '/:manga_slug/bulk-mark-unread',
  validateBody(chaptersBulkBodySchema),
  chapterController.markPreviousChaptersAsUnread,
);
router.post(
  '/add-history',
  validateBody(addChapterAsHistoryBodySchema),
  chapterController.addChapterAsHistory,
);
router.get('/:chapter_id/progress', chapterController.getChapterProgressById);
router.get('/recent', chapterController.getChapterFetchDate);
router.get('/status/:chapter_id', chapterController.getChapterReadStatusById);
router.get('/:manga_slug', chapterController.getChapter);

export default router;
