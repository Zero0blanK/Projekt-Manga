import express from 'express';
import downloadController from '../controllers/download.controller.js';
import { validateBody, validateQuery } from '../middleware/validate.middleware.js';
import { requireAdmin } from '../middleware/admin.middleware.js';
import { cbzRateLimit, pageRateLimit } from '../middleware/fileRateLimit.middleware.js';
import {
  initiateDownloadBodySchema,
  listPageQuerySchema,
  updateDownloadDirectoryBodySchema,
  updateDownloadStorageLimitBodySchema,
  cleanupOrphanedDownloadsBodySchema,
  restoreDownloadsBodySchema,
  scanDownloadsQuerySchema,
} from '@projekt-manga/schemas';
import type { NextFunction, Request, Response } from 'express';

const router = express.Router();

/**
 * Looking through a folder the caller names reads the host's disk, so it takes the same
 * rights as choosing the download folder. The folders the app already downloads to don't.
 */
function requireAdminForNamedFolder(req: Request, res: Response, next: NextFunction) {
  const named = (req.query as { root?: unknown }).root ?? (req.body as { root?: unknown })?.root;
  return named ? requireAdmin(req, res, next) : next();
}

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

// Downloads left by an earlier install, found on disk and added back.
router.get(
  '/restore/scan',
  requireAdminForNamedFolder,
  validateQuery(scanDownloadsQuerySchema),
  downloadController.scanForDownloads,
);
router.post(
  '/restore',
  requireAdminForNamedFolder,
  validateBody(restoreDownloadsBodySchema),
  downloadController.restoreDownloads,
);

// GET /api/downloads/chapter/:chapterId/check - Check if chapter is downloaded
router.get('/chapter/:chapterId/check', downloadController.isChapterDownloaded);

// GET /api/downloads/chapter/:chapterId/pages - Get pages for downloaded chapter
router.get('/chapter/:chapterId/pages', downloadController.getDownloadedChapterPages);

// GET /api/downloads/chapter/:chapterId/page/:index - Stream one downloaded page image
router.get(
  '/chapter/:chapterId/page/:index',
  pageRateLimit,
  downloadController.getDownloadedPageFile,
);

// GET /api/downloads/chapter/:chapterId/cbz - The downloaded chapter as a CBZ file
router.get('/chapter/:chapterId/cbz', cbzRateLimit, downloadController.getDownloadedChapterCbz);

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
router.get('/', validateQuery(listPageQuerySchema), downloadController.getAllDownloads);

// GET /api/downloads/:downloadId - Get download status
router.get('/:downloadId', downloadController.getDownloadStatus);

// PATCH /api/downloads/:downloadId/pause - Pause download
router.patch('/:downloadId/pause', downloadController.pauseDownload);

// PATCH /api/downloads/:downloadId/resume - Resume paused download
router.patch('/:downloadId/resume', downloadController.resumeDownload);

// DELETE /api/downloads/:downloadId - Cancel/Delete download
router.delete('/:downloadId', downloadController.cancelDownload);

export default router;
