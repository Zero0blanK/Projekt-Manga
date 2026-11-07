import { Request, Response, NextFunction } from 'express';
import { HTTPSuccessResponse } from '../utils/responseHandlers.js';
import mangaService from '../services/manga.service.js';
import trackerService from '../services/tracker.service.js';
import migrationService from '../services/migration.service.js';
import mangaOverrideService from '../services/mangaOverride.service.js';
import mangaLinkRepository from '../repositories/mangaLink.repository.js';
import type { TrackerService } from '@projekt-manga/types';
import type {
  GetMangaQuery,
  AddMangaBody,
  UpdateLibraryMembershipBody,
  LinkTrackerBody,
  MigrateMangaBody,
  UpdateMangaOverrideBody,
  UploadMangaCoverBody,
  CreateMangaLinkBody,
  ReorderMangaLinksBody,
} from '@projekt-manga/schemas';

const getManga = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const options = req.validated as GetMangaQuery;
    const manga = await mangaService.getManga(options, req.user?.id);
    return HTTPSuccessResponse(res, 200, 'Manga retrieved successfully', manga);
  } catch (error) {
    return next(error);
  }
};

const getMangaById = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { manga_id } = req.params as { manga_id: string };

    const manga = await mangaService.getMangaById(manga_id);
    return HTTPSuccessResponse(res, 200, 'Manga retrieved successfully', manga);
  } catch (error) {
    return next(error);
  }
};

const getMangaDetailsById = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { manga_id } = req.params as { manga_id: string };

    const manga = await mangaService.getMangaDetailsById(manga_id, req.user?.id);
    return HTTPSuccessResponse(res, 200, 'Manga with details retrieved successfully', manga);
  } catch (error) {
    return next(error);
  }
};

const addManga = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const manga_data = req.validated as AddMangaBody;
    const newManga = await mangaService.addManga(manga_data, req.user?.id);
    return HTTPSuccessResponse(res, 201, 'Manga added successfully', newManga);
  } catch (error) {
    return next(error);
  }
};

const addMangaToCategory = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { manga_slug, category_id } = req.params as { manga_slug: string; category_id: string };

    const mangaCategory = await mangaService.addMangaToCategory(
      manga_slug,
      category_id,
      req.user?.id,
    );
    return HTTPSuccessResponse(res, 201, 'Manga added to category successfully', mangaCategory);
  } catch (error) {
    return next(error);
  }
};

const deleteManga = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { manga_id } = req.params as { manga_id: string };

    await mangaService.deleteManga(manga_id, req.user?.id);
    return HTTPSuccessResponse(res, 200, 'Manga deleted successfully', null);
  } catch (error) {
    return next(error);
  }
};

const getMangaByCategoryId = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { category_id } = req.params as { category_id: string };
    const options = req.validated as GetMangaQuery;

    const manga = await mangaService.getMangaByCategoryId(category_id, options, req.user?.id);
    return HTTPSuccessResponse(res, 200, 'Manga retrieved by category ID successfully', manga);
  } catch (error) {
    return next(error);
  }
};

const setInLibrary = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { manga_id } = req.params as { manga_id: string };
    const { in_library } = req.validated as UpdateLibraryMembershipBody;
    const manga = await mangaService.setInLibrary(manga_id, in_library, req.user?.id);
    return HTTPSuccessResponse(
      res,
      200,
      in_library ? 'Manga added to library' : 'Manga removed from library',
      manga,
    );
  } catch (error) {
    return next(error);
  }
};

const getTrackerLinks = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { manga_id } = req.params as { manga_id: string };
    const links = await trackerService.getLinksForManga(req.user!.id, manga_id);
    return HTTPSuccessResponse(res, 200, 'Tracker links retrieved successfully', links);
  } catch (error) {
    return next(error);
  }
};

const linkTracker = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { manga_id } = req.params as { manga_id: string };
    const body = req.validated as LinkTrackerBody;
    const link = await trackerService.linkManga(
      req.user!.id,
      manga_id,
      body.tracker,
      body.tracker_media_id,
    );
    return HTTPSuccessResponse(res, 201, 'Manga linked to tracker successfully', link);
  } catch (error) {
    return next(error);
  }
};

const unlinkTracker = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { manga_id, tracker } = req.params as { manga_id: string; tracker: string };
    await trackerService.unlinkManga(
      req.user!.id,
      manga_id,
      tracker.toUpperCase() as TrackerService,
    );
    return HTTPSuccessResponse(res, 200, 'Tracker link removed successfully', null);
  } catch (error) {
    return next(error);
  }
};

/**
 * Migrates one library entry's reading state onto another, atomically.
 *
 * Not behind requireAuth: an account is optional in this app, and the anonymous path
 * migrates the shared rows exactly as the account path migrates the overlay ones. The
 * service takes req.user?.id and branches on it.
 */
const migrateManga = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { manga_id } = req.params as { manga_id: string };
    const body = req.validated as MigrateMangaBody;
    const summary = await migrationService.migrateManga(
      manga_id,
      body.to_manga_id,
      { removeOld: body.remove_old, moveHistory: body.move_history },
      req.user?.id,
    );
    return HTTPSuccessResponse(res, 200, 'Manga migrated successfully', summary);
  } catch (error) {
    return next(error);
  }
};

/** Local edits are per identity like the rest of the overlay: an account edits its own
 * row, anonymous use the shared one. */
// Linked sources: other sources' copies of a title, tried when it lacks a chapter or is
// down. Per identity like overrides, so anonymous use links its own library.
const getLinks = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { manga_id } = req.params as { manga_id: string };
    const group = await mangaLinkRepository.groupFor(manga_id, req.user?.id ?? null);
    return HTTPSuccessResponse(res, 200, 'Linked sources', group);
  } catch (error) {
    return next(error);
  }
};

const getAllLinks = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const groups = await mangaLinkRepository.listAll(req.user?.id ?? null);
    return HTTPSuccessResponse(res, 200, 'Linked sources', groups);
  } catch (error) {
    return next(error);
  }
};

const createLink = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { manga_id } = req.params as { manga_id: string };
    const { linked_manga_id } = req.validated as CreateMangaLinkBody;
    const user_id = req.user?.id ?? null;
    await mangaLinkRepository.create(manga_id, linked_manga_id, user_id);
    return HTTPSuccessResponse(
      res,
      201,
      'Source linked',
      await mangaLinkRepository.groupFor(manga_id, user_id),
    );
  } catch (error) {
    return next(error);
  }
};

const reorderLinks = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { manga_id } = req.params as { manga_id: string };
    const { link_ids } = req.validated as ReorderMangaLinksBody;
    const user_id = req.user?.id ?? null;
    await mangaLinkRepository.reorder(manga_id, link_ids, user_id);
    return HTTPSuccessResponse(
      res,
      200,
      'Order saved',
      await mangaLinkRepository.groupFor(manga_id, user_id),
    );
  } catch (error) {
    return next(error);
  }
};

const removeLink = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { manga_id, link_id } = req.params as { manga_id: string; link_id: string };
    const user_id = req.user?.id ?? null;
    await mangaLinkRepository.remove(manga_id, link_id, user_id);
    return HTTPSuccessResponse(
      res,
      200,
      'Source unlinked',
      await mangaLinkRepository.groupFor(manga_id, user_id),
    );
  } catch (error) {
    return next(error);
  }
};

const updateOverride = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { manga_id } = req.params as { manga_id: string };
    const override = await mangaOverrideService.updateOverride(
      manga_id,
      req.validated as UpdateMangaOverrideBody,
      req.user?.id,
    );
    return HTTPSuccessResponse(res, 200, 'Manga edits saved', override);
  } catch (error) {
    return next(error);
  }
};

const resetOverride = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { manga_id } = req.params as { manga_id: string };
    await mangaOverrideService.resetOverride(manga_id, req.user?.id);
    return HTTPSuccessResponse(res, 200, 'Manga reset to source', null);
  } catch (error) {
    return next(error);
  }
};

const uploadCover = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { manga_id } = req.params as { manga_id: string };
    const override = await mangaOverrideService.uploadCover(
      manga_id,
      req.validated as UploadMangaCoverBody,
      req.user?.id,
    );
    return HTTPSuccessResponse(res, 200, 'Cover saved', override);
  } catch (error) {
    return next(error);
  }
};

const removeCover = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { manga_id } = req.params as { manga_id: string };
    const override = await mangaOverrideService.removeCover(manga_id, req.user?.id);
    return HTTPSuccessResponse(res, 200, 'Cover reset to source', override);
  } catch (error) {
    return next(error);
  }
};

const mangaController = {
  getLinks,
  getAllLinks,
  createLink,
  reorderLinks,
  removeLink,
  updateOverride,
  resetOverride,
  uploadCover,
  removeCover,
  migrateManga,
  getManga,
  getMangaById,
  getMangaDetailsById,
  setInLibrary,
  addManga,
  addMangaToCategory,
  deleteManga,
  getMangaByCategoryId,
  getTrackerLinks,
  linkTracker,
  unlinkTracker,
};

export default mangaController;
