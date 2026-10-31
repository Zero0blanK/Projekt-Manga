import type { Request, Response, NextFunction } from 'express';
import type { UpdateBackupConfigBody } from '@projekt-manga/schemas';
import { backupFileNameSchema } from '@projekt-manga/schemas';
import { HTTPSuccessResponse } from '../utils/responseHandlers.js';
import {
  buildExport,
  createBackup,
  getBackupFile,
  getBackupStatus,
  updateBackupConfig,
} from '../services/backup.service.js';
import { NotFoundError, UnauthorizedError } from '../utils/customErrors.js';

/** Same guard as restore job polling: the browser names the owner it believes is signed
 * in, so a session that changed mid-click cannot receive the other account's history. */
function assertOwner(req: Request, action: string) {
  if (typeof req.query.owner === 'string' && req.query.owner !== (req.user?.id ?? 'anonymous')) {
    throw new UnauthorizedError(`Session changed; sign in again to ${action}`);
  }
}

export const exportBackup = async (req: Request, res: Response, next: NextFunction) => {
  try {
    assertOwner(req, 'export your data');
    const payload = await buildExport(req.user?.id);
    res.set('Cache-Control', 'no-store');
    return HTTPSuccessResponse(res, 200, 'Export built', payload);
  } catch (error) {
    return next(error);
  }
};

export const backupStatus = async (req: Request, res: Response, next: NextFunction) => {
  try {
    assertOwner(req, 'see your backups');
    const status = await getBackupStatus(req.user?.id);
    res.set('Cache-Control', 'no-store');
    return HTTPSuccessResponse(res, 200, 'Backup status', status);
  } catch (error) {
    return next(error);
  }
};

export const backupNow = async (req: Request, res: Response, next: NextFunction) => {
  try {
    assertOwner(req, 'back up your data');
    const file = await createBackup(req.user?.id);
    return HTTPSuccessResponse(res, 201, 'Backup written', file);
  } catch (error) {
    return next(error);
  }
};

export const downloadBackupFile = async (req: Request, res: Response, next: NextFunction) => {
  try {
    assertOwner(req, 'open this backup');
    const name = backupFileNameSchema.safeParse(req.params.name);
    // Reported as missing rather than invalid: a name outside the pattern can never exist.
    if (!name.success) throw new NotFoundError('Backup not found');
    const contents = await getBackupFile(name.data, req.user?.id);
    res.set('Cache-Control', 'no-store');
    return HTTPSuccessResponse(res, 200, 'Backup file', JSON.parse(contents));
  } catch (error) {
    return next(error);
  }
};

export const patchBackupConfig = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await updateBackupConfig(req.validated as UpdateBackupConfigBody);
    return HTTPSuccessResponse(res, 200, 'Backup settings saved', config);
  } catch (error) {
    return next(error);
  }
};
