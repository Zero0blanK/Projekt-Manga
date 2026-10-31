import type { Request, Response, NextFunction } from 'express';
import type { UpdateSourceNetworkConfigBody } from '@projekt-manga/schemas';
import { HTTPSuccessResponse } from '../utils/responseHandlers.js';
import {
  readSourceNetworkConfig,
  updateSourceNetworkConfig,
} from '../utils/sourceNetworkConfig.js';

export const getSourceNetworkConfig = (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.set('Cache-Control', 'no-store');
    return HTTPSuccessResponse(res, 200, 'Source network settings', readSourceNetworkConfig());
  } catch (error) {
    return next(error);
  }
};

export const patchSourceNetworkConfig = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await updateSourceNetworkConfig(req.validated as UpdateSourceNetworkConfigBody);
    return HTTPSuccessResponse(res, 200, 'Source network settings saved', config);
  } catch (error) {
    return next(error);
  }
};
