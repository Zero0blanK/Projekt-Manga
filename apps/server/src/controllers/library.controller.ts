import { Request, Response, NextFunction } from 'express';
import { HTTPSuccessResponse } from '../utils/responseHandlers.js';
import libraryService from '../services/library.service.js';
import type { UpdateLibraryStateBody } from '@projekt-manga/schemas';

const getLibraryState = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const state = await libraryService.getLibraryState(req.user?.id);
    return HTTPSuccessResponse(res, 200, 'Library state retrieved successfully', state);
  } catch (error) {
    return next(error);
  }
};

const updateLibraryState = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { manga_id } = req.params as { manga_id: string };
    const patch = req.validated as UpdateLibraryStateBody;

    const updated = await libraryService.updateLibraryState(manga_id, patch, req.user?.id);
    return HTTPSuccessResponse(res, 200, 'Library state updated successfully', updated);
  } catch (error) {
    return next(error);
  }
};

const libraryController = {
  getLibraryState,
  updateLibraryState,
};

export default libraryController;
