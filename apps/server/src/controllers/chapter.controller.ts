import { Request, Response, NextFunction } from 'express';
import { HTTPSuccessResponse } from '../utils/responseHandlers.js';
import chapterService from '../services/chapter.service.js';
import type {
  ChapterMetaBody,
  ChaptersBulkBody,
  AddChapterAsHistoryBody,
} from '@projekt-manga/schemas';

const markChapterAsRead = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { manga_slug, chapter_id } = req.params as { manga_slug: string; chapter_id: string };
    const chapter_meta = req.validated as ChapterMetaBody;

    const chapter = await chapterService.markChapterAsRead(
      manga_slug,
      chapter_id,
      chapter_meta,
      req.user?.id,
    );
    return HTTPSuccessResponse(res, 200, 'Chapter marked as read successfully', chapter);
  } catch (error) {
    next(error);
  }
};

const markChapterAsUnread = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { manga_slug, chapter_id } = req.params as { manga_slug: string; chapter_id: string };
    const chapter_meta = req.validated as ChapterMetaBody;

    const chapter = await chapterService.markChapterAsUnread(
      manga_slug,
      chapter_id,
      chapter_meta,
      req.user?.id,
    );
    return HTTPSuccessResponse(res, 200, 'Chapter marked as unread successfully', chapter);
  } catch (error) {
    next(error);
  }
};

const markChapterByLastPage = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { manga_slug, chapter_id, last_page_read } = req.params as {
      manga_slug: string;
      chapter_id: string;
      last_page_read: string;
    };

    const chapter_meta = req.validated as ChapterMetaBody;
    const lastPageRead = Number.parseInt(last_page_read, 10);
    if (!Number.isFinite(lastPageRead)) {
      return res.status(400).json({ success: false, message: 'last_page_read must be a number' });
    }

    const chapter = await chapterService.markChapterByLastPage(
      manga_slug,
      chapter_id,
      lastPageRead,
      chapter_meta,
      req.user?.id,
    );
    return HTTPSuccessResponse(res, 200, 'Chapter marked by last page successfully', chapter);
  } catch (error) {
    next(error);
  }
};

const markPreviousChaptersAsRead = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { manga_slug } = req.params as { manga_slug: string };
    const { chapters, source_manga_id, title, thumbnail_url } = req.validated as ChaptersBulkBody;

    const result = await chapterService.markPreviousChaptersAsRead(
      manga_slug,
      chapters ?? [],
      { source_manga_id, title, thumbnail_url },
      req.user?.id,
    );

    return HTTPSuccessResponse(res, 200, 'Previous chapters marked as read successfully', result);
  } catch (error) {
    next(error);
  }
};

const markPreviousChaptersAsUnread = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { manga_slug } = req.params as { manga_slug: string };
    const { chapters, source_manga_id, title, thumbnail_url } = req.validated as ChaptersBulkBody;

    const result = await chapterService.markPreviousChaptersAsUnread(
      manga_slug,
      chapters ?? [],
      { source_manga_id, title, thumbnail_url },
      req.user?.id,
    );

    return HTTPSuccessResponse(res, 200, 'Previous chapters marked as unread successfully', result);
  } catch (error) {
    next(error);
  }
};

const getChapter = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { manga_slug } = req.params as { manga_slug: string };
    const source = typeof req.query.source === 'string' ? req.query.source : undefined;
    const chapter = await chapterService.getChapter(manga_slug, req.user?.id, source);
    return HTTPSuccessResponse(res, 200, 'Chapter retrieved successfully', chapter);
  } catch (error) {
    next(error);
  }
};

const getChapterProgressById = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { chapter_id } = req.params as { chapter_id: string };

    const chapterProgress = await chapterService.getChapterProgressById(chapter_id, req.user?.id);
    return HTTPSuccessResponse(
      res,
      200,
      'Chapter progress retrieved successfully',
      chapterProgress,
    );
  } catch (error) {
    next(error);
  }
};

const getChapterFetchDate = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const chapters = await chapterService.getChapterFetchDate();
    return HTTPSuccessResponse(res, 200, 'Chapter fetch date retrieved successfully', chapters);
  } catch (error) {
    next(error);
  }
};

const addChapterAsHistory = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const chapterData = req.validated as AddChapterAsHistoryBody;
    const chapter = await chapterService.addChapterAsHistory(chapterData);
    return HTTPSuccessResponse(res, 201, 'Chapter added as history successfully', chapter);
  } catch (error) {
    next(error);
  }
};

const getChapterReadStatusById = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { chapter_id } = req.params as { chapter_id: string };

    const chapterStatus = await chapterService.getChapterReadStatusById(chapter_id, req.user?.id);
    return HTTPSuccessResponse(
      res,
      200,
      'Chapter read status retrieved successfully',
      chapterStatus,
    );
  } catch (error) {
    next(error);
  }
};

const chapterController = {
  markChapterAsRead,
  markChapterAsUnread,
  markChapterByLastPage,
  markPreviousChaptersAsRead,
  markPreviousChaptersAsUnread,
  getChapter,
  getChapterProgressById,
  getChapterFetchDate,
  addChapterAsHistory,
  getChapterReadStatusById,
};

export default chapterController;
