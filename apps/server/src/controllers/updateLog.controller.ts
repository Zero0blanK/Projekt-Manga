import { Request, Response, NextFunction } from 'express';
import { HTTPSuccessResponse } from '../utils/responseHandlers.js';
import updateLogService from '../services/updateLog.service.js';
import type { UpdateLogQuery } from '@projekt-manga/schemas';

const getRecent = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { limit } = req.validated as UpdateLogQuery;
    const entries = await updateLogService.getRecent(limit);
    return HTTPSuccessResponse(res, 200, 'Update log retrieved successfully', entries);
  } catch (error) {
    return next(error);
  }
};

const updateLogController = {
  getRecent,
};

export default updateLogController;
