import { Request, Response, NextFunction } from 'express';
import { HTTPSuccessResponse } from '../utils/responseHandlers.js';
import syncService from '../services/sync.service.js';
import type { SyncPullQuery, SyncPushBody } from '@projekt-manga/schemas';
import userRepository from '../repositories/user.repository.js';

const generation = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const generation = await userRepository.getSyncGeneration(req.user!.id);
    res.set('Cache-Control', 'no-store');
    return HTTPSuccessResponse(res, 200, 'Sync generation', { generation });
  } catch (error) {
    return next(error);
  }
};

const pull = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // requireAuth (mounted on this route) guarantees req.user is set.
    const { since } = req.validated as SyncPullQuery;
    const result = await syncService.pull(req.user!.id, since);
    return HTTPSuccessResponse(res, 200, 'Sync pull successful', result);
  } catch (error) {
    return next(error);
  }
};

const push = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.validated as SyncPushBody;
    const result = await syncService.push(req.user!.id, body);
    return HTTPSuccessResponse(res, 200, 'Sync push successful', result);
  } catch (error) {
    return next(error);
  }
};

const syncController = { pull, push, generation };

export default syncController;
