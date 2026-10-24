import type { Request, Response, NextFunction } from 'express';
import type { PreviewBackupBody, ReplaceBackupBody } from '@projekt-manga/schemas';
import { HTTPSuccessResponse } from '../utils/responseHandlers.js';
import {
  cancelRestore,
  getRestore,
  previewRestore,
  startRestore,
} from '../services/restore.service.js';
import { UnauthorizedError } from '../utils/customErrors.js';

export const startRestoreJob = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const backup = req.validated as ReplaceBackupBody;
    if (backup.expectedUserId !== (req.user?.id ?? null)) {
      throw new UnauthorizedError('Session changed; sign in again before restoring');
    }
    const job = await startRestore(backup, req.user?.id);
    return HTTPSuccessResponse(res, 202, 'Restore queued', { id: job.id, state: job.state });
  } catch (error) {
    return next(error);
  }
};

export const previewRestoreJob = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const backup = req.validated as PreviewBackupBody;
    if (backup.expectedUserId !== (req.user?.id ?? null)) {
      throw new UnauthorizedError('Session changed; sign in again before previewing this restore');
    }
    const preview = await previewRestore(backup, req.user?.id);
    res.set('Cache-Control', 'no-store');
    return HTTPSuccessResponse(res, 200, 'Restore preview', preview);
  } catch (error) {
    return next(error);
  }
};

export const getRestoreJob = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (typeof req.query.owner === 'string' && req.query.owner !== (req.user?.id ?? 'anonymous')) {
      throw new UnauthorizedError('Session changed; sign in again to check the restore');
    }
    const job = await getRestore(req.params.id as string, req.user?.id);
    res.set('Cache-Control', 'no-store');
    return HTTPSuccessResponse(res, 200, 'Restore status', {
      id: job.id,
      state: job.state,
      result: job.result ?? null,
      progress: job.progress,
    });
  } catch (error) {
    return next(error);
  }
};

export const cancelRestoreJob = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (typeof req.query.owner === 'string' && req.query.owner !== (req.user?.id ?? 'anonymous')) {
      throw new UnauthorizedError('Session changed; sign in again to cancel the restore');
    }
    const job = await cancelRestore(req.params.id as string, req.user?.id);
    res.set('Cache-Control', 'no-store');
    return HTTPSuccessResponse(res, 200, 'Restore cancellation status', {
      id: job.id,
      state: job.state,
      result: job.result,
      progress: job.progress,
    });
  } catch (error) {
    return next(error);
  }
};
