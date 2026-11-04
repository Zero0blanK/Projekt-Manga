import type { Request, Response, NextFunction } from 'express';
import {
  suwayomiExtensionParamsSchema,
  type SuwayomiExtensionActionBody,
  type SuwayomiSettingsBody,
} from '@projekt-manga/schemas';
import { HTTPSuccessResponse } from '../utils/responseHandlers.js';
import {
  ServiceUnavailableError,
  UnauthorizedError,
  ValidationError,
} from '../utils/customErrors.js';
import {
  getSuwayomiSettings,
  removeSuwayomiSettings,
  saveSuwayomiSettings,
} from '../services/suwayomi/settings.js';
import { SuwayomiError, suwayomiGraphql } from '../services/suwayomi/client.js';
import { fetchSuwayomiSourceInfos } from '../services/suwayomi/registry.js';
import { buildLibraryImport, fetchSuwayomiLibrary } from '../services/suwayomi/libraryImport.js';
import { startRestore } from '../services/restore.service.js';
import {
  changeSuwayomiExtension,
  listSuwayomiExtensions,
} from '../services/suwayomi/extensions.js';

export const getSettings = (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.set('Cache-Control', 'no-store');
    return HTTPSuccessResponse(res, 200, 'Suwayomi settings', getSuwayomiSettings());
  } catch (error) {
    return next(error);
  }
};

export const putSettings = async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.set('Cache-Control', 'no-store');
    const saved = await saveSuwayomiSettings(req.validated as SuwayomiSettingsBody);
    return HTTPSuccessResponse(res, 200, 'Suwayomi settings saved', saved);
  } catch (error) {
    return next(error);
  }
};

export const deleteSettings = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    await removeSuwayomiSettings();
    return HTTPSuccessResponse(res, 200, 'Suwayomi settings removed', null);
  } catch (error) {
    return next(error);
  }
};

/** Asks the saved server for its name and version and lists its sources. */
export const testConnection = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.set('Cache-Control', 'no-store');
    const about = await suwayomiGraphql<{ aboutServer: { name?: string; version?: string } }>(
      'query { aboutServer { name version } }',
    );
    const sources = await fetchSuwayomiSourceInfos();
    return HTTPSuccessResponse(res, 200, 'Suwayomi server reachable', {
      name: about.aboutServer?.name || 'Suwayomi',
      version: about.aboutServer?.version || '',
      sources: sources.length,
    });
  } catch (error) {
    if (error instanceof SuwayomiError) {
      if (error.code === 'BLOCKED') return next(new UnauthorizedError(error.message));
      // Only the admin sees this, and the address is their own setting: naming it says
      // what to check.
      const url = getSuwayomiSettings()?.url;
      if (error.code === 'NETWORK_ERROR' && url) {
        return next(
          new ServiceUnavailableError(
            `Nothing answered at ${url}. Check that Suwayomi is running and that the address and port match its web interface.`,
          ),
        );
      }
      return next(new ServiceUnavailableError(error.message));
    }
    return next(error);
  }
};

/** A Suwayomi failure as an HTTP error: a refused login, or the server not answering. */
const toHttpError = (error: unknown) =>
  error instanceof SuwayomiError
    ? error.code === 'BLOCKED'
      ? new UnauthorizedError(error.message)
      : new ServiceUnavailableError(error.message)
    : error;

/** Queues a merge of the Suwayomi server's library into this one. */
export const importLibrary = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const backup = buildLibraryImport(await fetchSuwayomiLibrary(), req.user?.id ?? null);
    const job = await startRestore(backup, req.user?.id);
    return HTTPSuccessResponse(res, 202, 'Suwayomi library import queued', {
      id: job.id,
      titles: backup.manga.length,
    });
  } catch (error) {
    return next(toHttpError(error));
  }
};

export const getExtensions = async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.set('Cache-Control', 'no-store');
    const extensions = await listSuwayomiExtensions(req.query.refresh === '1');
    return HTTPSuccessResponse(res, 200, 'Suwayomi extensions', extensions);
  } catch (error) {
    return next(toHttpError(error));
  }
};

export const changeExtension = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const params = suwayomiExtensionParamsSchema.safeParse(req.params);
    if (!params.success) throw new ValidationError('Not an extension package name');
    const { pkg_name } = params.data;
    const { action } = req.validated as SuwayomiExtensionActionBody;
    const extension = await changeSuwayomiExtension(pkg_name, action);
    return HTTPSuccessResponse(res, 200, 'Suwayomi extension changed', extension);
  } catch (error) {
    return next(toHttpError(error));
  }
};
