import express from 'express';
import downloadController from '../controllers/download.controller.js';
import { validateBody } from '../middleware/validate.middleware.js';
import { requireAdmin } from '../middleware/admin.middleware.js';
import {
  initiateDownloadBodySchema,
  updateDownloadDirectoryBodySchema,
  updateDownloadStorageLimitBodySchema,
  cleanupOrphanedDownloadsBodySchema,
} from '@projekt-manga/schemas';

const router = express.Router();

// POST /api/downloads/chapter - Initiate chapter download
router.post(
  '/chapter',
  validateBody(initiateDownloadBodySchema),
  downloadController.initiateDownload,
);

// GET /api/downloads/stats - Get download statistics
router.get('/stats', downloadController.getDownloadStats);
router.patch(
  '/storage-limit',
  validateBody(updateDownloadStorageLimitBodySchema),
  downloadController.updateDownloadStorageLimit,
);
router.get('/orphans', downloadController.getOrphanedDownloadFolders);
router.post(
  '/orphans/cleanup',
  validateBody(cleanupOrphanedDownloadsBodySchema),
  downloadController.cleanupOrphanedDownloadFolders,
);

// GET /api/downloads/chapter/:chapterId/check - Check if chapter is downloaded
router.get('/chapter/:chapterId/check', downloadController.isChapterDownloaded);

// GET /api/downloads/chapter/:chapterId/pages - Get pages for downloaded chapter
router.get('/chapter/:chapterId/pages', downloadController.getDownloadedChapterPages);

// GET /api/downloads/chapter/:chapterId/page/:index - Stream one downloaded page image
router.get('/chapter/:chapterId/page/:index', downloadController.getDownloadedPageFile);

// GET /api/downloads/directory - Get active download directory
router.get('/directory', requireAdmin, downloadController.getDownloadDirectory);

// PATCH /api/downloads/directory - Set/reset active download directory
router.patch(
  '/directory',
  requireAdmin,
  validateBody(updateDownloadDirectoryBodySchema),
  downloadController.updateDownloadDirectory,
);

// GET /api/downloads - Get all downloads
router.get('/', downloadController.getAllDownloads);

// GET /api/downloads/:downloadId - Get download status
router.get('/:downloadId', downloadController.getDownloadStatus);

// PATCH /api/downloads/:downloadId/pause - Pause download
router.patch('/:downloadId/pause', downloadController.pauseDownload);

// PATCH /api/downloads/:downloadId/resume - Resume paused download
router.patch('/:downloadId/resume', downloadController.resumeDownload);

// DELETE /api/downloads/:downloadId - Cancel/Delete download
router.delete('/:downloadId', downloadController.cancelDownload);

export default router;
