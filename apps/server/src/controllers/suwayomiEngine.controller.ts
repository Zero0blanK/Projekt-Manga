import type { Request, Response, NextFunction } from 'express';
import type {
  SuwayomiEngineRepositoriesBody,
  SuwayomiEngineSettingsBody,
  SuwayomiModeBody,
} from '@projekt-manga/schemas';
import { HTTPSuccessResponse } from '../utils/responseHandlers.js';
import {
  DuplicateResourceError,
  ServiceUnavailableError,
  ValidationError,
} from '../utils/customErrors.js';
import { setSuwayomiMode } from '../services/suwayomi/settings.js';
import { SuwayomiError } from '../services/suwayomi/client.js';
import {
  EngineBusyError,
  cancelEngineDownload,
  checkEngineUpdates,
  engineStatus,
  installBuiltInEngine,
  removeBuiltInEngine,
  startBuiltInEngine,
  stopBuiltInEngine,
  updateBuiltInEngine,
  updateEngineSettings,
} from '../services/suwayomi/engine/index.js';
import { readRecord } from '../services/suwayomi/engine/layout.js';
import {
  getEngineRepositories,
  setEngineRepositories,
} from '../services/suwayomi/engine/repositories.js';
import { EngineDownloadError } from '../services/suwayomi/engine/download.js';

/**
 * The built-in extension engine's API (admin only, like the rest of /api/suwayomi). A
 * download runs in the background and answers 202; its progress is in the status, which
 * open apps re-read on the library stream's `engine` event.
 */

function engineError(error: unknown): unknown {
  if (error instanceof EngineBusyError) return new DuplicateResourceError(error.message);
  if (error instanceof EngineDownloadError) return new ServiceUnavailableError(error.message);
  if (error instanceof SuwayomiError) return new ServiceUnavailableError(error.message);
  if (
    error instanceof Error &&
    /not installed|Check for updates first|memory limit/.test(error.message)
  ) {
    return new ValidationError(error.message);
  }
  return error;
}

const handle =
  (work: (req: Request, res: Response) => Promise<unknown>) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.set('Cache-Control', 'no-store');
      await work(req, res);
    } catch (error) {
      next(engineError(error));
    }
  };

const sendStatus = async (res: Response, code = 200, message = 'Extension engine') =>
  HTTPSuccessResponse(res, code, message, await engineStatus());

export const getEngine = handle((_req, res) => sendStatus(res));

export const installEngine = handle(async (_req, res) => {
  installBuiltInEngine();
  await sendStatus(res, 202, 'Downloading the extension engine');
});

export const updateEngine = handle(async (_req, res) => {
  updateBuiltInEngine();
  await sendStatus(res, 202, 'Updating the extension engine');
});

export const cancelDownload = handle(async (_req, res) => {
  cancelEngineDownload();
  await sendStatus(res);
});

export const checkUpdates = handle(async (_req, res) => {
  await checkEngineUpdates();
  await sendStatus(res);
});

export const startEngine = handle(async (_req, res) => {
  await startBuiltInEngine();
  await sendStatus(res);
});

export const stopEngine = handle(async (_req, res) => {
  await stopBuiltInEngine();
  await sendStatus(res);
});

export const removeEngine = handle(async (req, res) => {
  const { keep_data } = req.validated as { keep_data?: 'true' | 'false' };
  await removeBuiltInEngine({ keepData: keep_data === 'true' });
  await sendStatus(res, 200, 'Extension engine removed');
});

export const putEngineSettings = handle(async (req, res) => {
  const body = req.validated as SuwayomiEngineSettingsBody;
  await updateEngineSettings({
    memoryMb: body.memory_mb,
    startWithServer: body.start_with_server,
  });
  await sendStatus(res);
});

export const getRepositories = handle(async (_req, res) =>
  HTTPSuccessResponse(res, 200, 'Extension repositories', await getEngineRepositories()),
);

export const putRepositories = handle(async (req, res) => {
  const { repositories } = req.validated as SuwayomiEngineRepositoriesBody;
  return HTTPSuccessResponse(
    res,
    200,
    'Extension repositories saved',
    await setEngineRepositories(repositories),
  );
});

/** Chooses where Suwayomi sources come from. Choosing the built-in engine starts it when
 * it's installed; choosing anything else stops it. */
export const putMode = handle(async (req, res) => {
  const { mode } = req.validated as SuwayomiModeBody;
  let saved;
  try {
    saved = await setSuwayomiMode(mode);
  } catch (error) {
    throw new ValidationError((error as Error).message);
  }
  if (mode === 'built-in') {
    if (readRecord()) await startBuiltInEngine();
  } else {
    await stopBuiltInEngine();
  }
  return HTTPSuccessResponse(res, 200, 'Suwayomi source mode saved', saved);
});
