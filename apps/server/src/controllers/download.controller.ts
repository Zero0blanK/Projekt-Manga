import { Request, Response, NextFunction } from 'express';
import { HTTPSuccessResponse, HTTPErrorResponse } from '../utils/responseHandlers.js';
import downloadService from '../services/download.service.js';
import { NotFoundError } from '../utils/customErrors.js';
import { writeStoredZip } from '../utils/storedZip.js';
import type {
  CleanupOrphanedDownloadsBody,
  InitiateDownloadBody,
  ListPageQuery,
  UpdateDownloadDirectoryBody,
  UpdateDownloadStorageLimitBody,
} from '@projekt-manga/schemas';

const initiateDownload = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sourceId, mangaSlug, mangaTitle, chapter } = req.validated as InitiateDownloadBody;

    const result = await downloadService.initiateDownload({
      sourceId,
      mangaSlug,
      chapterId: chapter.id,
      mangaTitle,
      chapterTitle: chapter.name || `Chapter ${chapter.chapter_number}`,
      chapterNumber: chapter.chapter_number,
    });
    return HTTPSuccessResponse(res, 200, 'Download initiated successfully', result);
  } catch (error) {
    next(error);
  }
};

const getDownloadStatus = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { downloadId } = req.params as { downloadId: string };

    const status = await downloadService.getDownloadStatus(downloadId);
    return HTTPSuccessResponse(res, 200, 'Download status retrieved successfully', status);
  } catch (error) {
    next(error);
  }
};

const getAllDownloads = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const downloads = await downloadService.getAllDownloads(req.validated as ListPageQuery);
    return HTTPSuccessResponse(res, 200, 'Downloads retrieved successfully', downloads);
  } catch (error) {
    next(error);
  }
};

const getDownloadDirectory = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const directory = downloadService.getDownloadDir();
    return HTTPSuccessResponse(res, 200, 'Download directory retrieved', { path: directory });
  } catch (error) {
    next(error);
  }
};

const updateDownloadDirectory = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { path } = req.validated as UpdateDownloadDirectoryBody;
    const requestedPath = path?.trim() ?? '';
    const directory = requestedPath
      ? downloadService.setDownloadDir(requestedPath)
      : downloadService.resetDownloadDir();

    return HTTPSuccessResponse(res, 200, 'Download directory updated', { path: directory });
  } catch (error) {
    next(error);
  }
};

const cancelDownload = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { downloadId } = req.params as { downloadId: string };

    await downloadService.cancelDownload(downloadId);
    return HTTPSuccessResponse(res, 200, 'Download cancelled successfully', { id: downloadId });
  } catch (error) {
    next(error);
  }
};

const updateDownloadStorageLimit = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { bytes } = req.validated as UpdateDownloadStorageLimitBody;
    await downloadService.setDownloadStorageLimitBytes(bytes);
    return HTTPSuccessResponse(res, 200, 'Download storage limit updated', { bytes });
  } catch (error) {
    next(error);
  }
};

const pauseDownload = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { downloadId } = req.params as { downloadId: string };

    await downloadService.pauseDownload(downloadId);
    return HTTPSuccessResponse(res, 200, 'Download paused successfully', { id: downloadId });
  } catch (error) {
    next(error);
  }
};

const resumeDownload = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { downloadId } = req.params as { downloadId: string };

    await downloadService.resumeDownload(downloadId);
    return HTTPSuccessResponse(res, 200, 'Download resumed successfully', { id: downloadId });
  } catch (error) {
    next(error);
  }
};

const getDownloadStats = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const stats = await downloadService.getDownloadStats();
    return HTTPSuccessResponse(res, 200, 'Download statistics retrieved successfully', stats);
  } catch (error) {
    next(error);
  }
};

const getOrphanedDownloadFolders = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const folders = await downloadService.getOrphanedDownloadFolders();
    return HTTPSuccessResponse(res, 200, 'Orphaned download folders retrieved', folders);
  } catch (error) {
    next(error);
  }
};

const cleanupOrphanedDownloadFolders = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ids } = req.validated as CleanupOrphanedDownloadsBody;
    const result = await downloadService.cleanupOrphanedDownloadFolders(ids);
    return HTTPSuccessResponse(res, 200, 'Orphaned download folders cleaned', result);
  } catch (error) {
    next(error);
  }
};

const isChapterDownloaded = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { chapterId } = req.params as { chapterId: string };

    const isDownloaded = await downloadService.isChapterDownloaded(chapterId);
    return HTTPSuccessResponse(res, 200, 'Check completed', { isDownloaded });
  } catch (error) {
    next(error);
  }
};

const getDownloadedChapterPages = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { chapterId } = req.params as { chapterId: string };

    const pages = await downloadService.getDownloadedChapterPages(chapterId);
    return HTTPSuccessResponse(res, 200, 'Downloaded chapter pages retrieved', pages);
  } catch (error) {
    // The reader asks this for every chapter it opens, and "not downloaded" is the normal
    // answer, not a failure: an empty list tells it to read from the source without a 404
    // in the browser console on every chapter.
    if (error instanceof NotFoundError) {
      return HTTPSuccessResponse(res, 200, 'Chapter is not downloaded', []);
    }
    next(error);
  }
};

/**
 * Streams one page of a downloaded chapter. Unlike every other handler here the body is
 * the image itself, not a JSON envelope — it's consumed directly by an <img src> in the
 * reader, which is what makes offline reading work.
 */
const getDownloadedPageFile = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { chapterId, index } = req.params as { chapterId: string; index: string };

    const pageIndex = Number(index);
    if (!Number.isInteger(pageIndex) || pageIndex < 0) {
      return HTTPErrorResponse(res, 400, 'Invalid page index');
    }

    const filePath = await downloadService.getDownloadedPageFile(chapterId, pageIndex);

    // Local files that only change when the chapter is re-downloaded, and the URL is keyed
    // by chapter id + index — safe to let the browser hold on to them while reading.
    res.setHeader('Cache-Control', 'private, max-age=86400');
    return res.sendFile(filePath);
  } catch (error) {
    next(error);
  }
};

/** A file name safe on every desktop OS, for the Content-Disposition header. */
function safeFileName(name: string): string {
  const cleaned = name
    .split('')
    .map((char) => (char.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(char) ? ' ' : char))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150);
  return cleaned || 'chapter.cbz';
}

/**
 * A downloaded chapter as a CBZ, for "Export as CBZ". Streamed as it is built; a failure
 * once bytes have gone out can only cut the response short, so the client sees a broken
 * download rather than a corrupt file that looks complete.
 */
const getDownloadedChapterCbz = async (req: Request, res: Response, next: NextFunction) => {
  let archive: Awaited<ReturnType<typeof downloadService.getDownloadedChapterArchive>>;
  try {
    const { chapterId } = req.params as { chapterId: string };
    archive = await downloadService.getDownloadedChapterArchive(chapterId);
  } catch (error) {
    return next(error);
  }
  const fileName = safeFileName(archive.fileName);
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
  res.setHeader('Content-Type', 'application/vnd.comicbook+zip');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
  );
  res.setHeader('Cache-Control', 'no-store');
  try {
    await writeStoredZip(archive.entries, res);
    res.end();
  } catch (error) {
    console.error('[downloads] CBZ export failed:', error instanceof Error ? error.message : error);
    res.destroy();
  }
};

const downloadController = {
  initiateDownload,
  getDownloadDirectory,
  updateDownloadDirectory,
  updateDownloadStorageLimit,
  getDownloadStatus,
  getAllDownloads,
  cancelDownload,
  pauseDownload,
  resumeDownload,
  getDownloadStats,
  getOrphanedDownloadFolders,
  cleanupOrphanedDownloadFolders,
  isChapterDownloaded,
  getDownloadedChapterPages,
  getDownloadedPageFile,
  getDownloadedChapterCbz,
};

export default downloadController;
