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

/**
 * The installed source's icon, stored when it was installed, so it shows offline. SVG is
 * served too: the sandbox CSP keeps it inert if someone opens the URL directly, and as an
 * <img> it never runs script anyway.
 */
const getInstalledExtensionIcon = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params as { id: string };
    const icon = await extensionRepositoryService.getInstalledIcon(id);
    res.setHeader('Content-Type', icon.type);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    );
    res.setHeader('Cache-Control', 'private, max-age=3600');
    return res.status(200).send(icon.data);
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
  getInstalledExtensionIcon,
};

export default extensionRepositoryController;
