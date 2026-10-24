import { Request, Response, NextFunction } from 'express';
import { HTTPSuccessResponse } from '../utils/responseHandlers.js';
import extensionRepositoryService from '../services/extensionRepository.service.js';
import type { AddExtensionRepositoryBody, InstallExtensionBody } from '@projekt-manga/schemas';

const listRepositories = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const repositories = await extensionRepositoryService.listRepositoriesWithListings();
    return HTTPSuccessResponse(res, 200, 'Repositories retrieved successfully', repositories);
  } catch (error) {
    return next(error);
  }
};

const addRepository = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.validated as AddExtensionRepositoryBody;
    const repository = await extensionRepositoryService.addRepository(body.url);
    return HTTPSuccessResponse(res, 201, 'Repository added successfully', repository);
  } catch (error) {
    return next(error);
  }
};

const refreshRepository = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params as { id: string };
    const repository = await extensionRepositoryService.refreshRepository(id);
    return HTTPSuccessResponse(res, 200, 'Repository refreshed successfully', repository);
  } catch (error) {
    return next(error);
  }
};

const deleteRepository = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params as { id: string };
    await extensionRepositoryService.deleteRepository(id);
    return HTTPSuccessResponse(res, 200, 'Repository deleted successfully', null);
  } catch (error) {
    return next(error);
  }
};

const listInstalledExtensions = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const installed = await extensionRepositoryService.getAllInstalledExtensions();
    return HTTPSuccessResponse(res, 200, 'Installed extensions retrieved successfully', installed);
  } catch (error) {
    return next(error);
  }
};

const installExtension = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.validated as InstallExtensionBody;
    const installed = await extensionRepositoryService.installExtension(
      body.repository_id,
      body.source_key,
      body.acknowledge_unsigned === true,
    );
    return HTTPSuccessResponse(res, 201, 'Extension installed successfully', installed);
  } catch (error) {
    return next(error);
  }
};

const updateInstalledExtension = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params as { id: string };
    const result = await extensionRepositoryService.updateExtension(id);
    return HTTPSuccessResponse(
      res,
      200,
      result.changed ? 'Extension updated successfully' : 'Extension is already up to date',
      result,
    );
  } catch (error) {
    return next(error);
  }
};

const deleteInstalledExtension = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params as { id: string };
    await extensionRepositoryService.deleteInstalledExtension(id);
    return HTTPSuccessResponse(res, 200, 'Extension removed successfully', null);
  } catch (error) {
    return next(error);
  }
};

const extensionRepositoryController = {
  listRepositories,
  addRepository,
  refreshRepository,
  deleteRepository,
  listInstalledExtensions,
  installExtension,
  updateInstalledExtension,
  deleteInstalledExtension,
};

export default extensionRepositoryController;
