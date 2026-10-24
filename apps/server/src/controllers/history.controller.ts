import { Request, Response, NextFunction } from 'express';
import { HTTPSuccessResponse } from '../utils/responseHandlers.js';
import historyService from '../services/history.service.js';
import type { AddHistoryBody } from '@projekt-manga/schemas';

const getHistory = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const history = await historyService.getHistory(req.user?.id);
    return HTTPSuccessResponse(res, 200, 'Manga history retrieved successfully', history);
  } catch (error) {
    return next(error);
  }
};

const addHistory = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const historyData = req.validated as AddHistoryBody;
    const newHistory = await historyService.addHistory(historyData, req.user?.id);
    return HTTPSuccessResponse(res, 201, 'Manga history added successfully', newHistory);
  } catch (error) {
    return next(error);
  }
};

const getHistoryByMangaSlug = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { manga_slug } = req.params as { manga_slug: string };
    const source = typeof req.query.source === 'string' ? req.query.source : undefined;
    const history = await historyService.getHistoryByMangaSlug(manga_slug, req.user?.id, source);
    return HTTPSuccessResponse(res, 200, 'Manga history retrieved successfully', history);
  } catch (error) {
    return next(error);
  }
};

const deleteHistory = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params as { id: string };
    await historyService.deleteHistory(id, req.user?.id);
    return HTTPSuccessResponse(res, 200, 'Manga history deleted successfully');
  } catch (error) {
    return next(error);
  }
};

const historyController = {
  getHistory,
  addHistory,
  getHistoryByMangaSlug,
  deleteHistory,
};

export default historyController;
