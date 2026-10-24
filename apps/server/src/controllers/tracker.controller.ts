import { Request, Response, NextFunction } from 'express';
import { HTTPSuccessResponse } from '../utils/responseHandlers.js';
import trackerService from '../services/tracker.service.js';
import { isTrackerService, type TrackerService } from '@projekt-manga/types';
import { AppError, ValidationError } from '../utils/customErrors.js';
import type {
  TrackerCallbackQuery,
  TrackerSearchQuery,
  LinkTrackerBody,
} from '@projekt-manga/schemas';

function clientUrl(): string {
  return process.env.CLIENT_URL || 'http://localhost:3000';
}

/**
 * Validates a `:tracker` path segment rather than casting it.
 *
 * Under SQLite the column is a plain String and would happily store "FOO", so this is the
 * only thing keeping the stored vocabulary closed. That in turn is what makes it sound for
 * the read path to treat `tracker` as the union (see tracker.service.ts's EnabledLinks).
 */
function parseTracker(raw: string): TrackerService {
  const normalized = (raw ?? '').trim().toUpperCase();
  if (!isTrackerService(normalized)) {
    throw new ValidationError(`Unknown tracker "${raw}"`);
  }
  return normalized;
}

const listConnected = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const trackers = await trackerService.getConnectedTrackers(req.user!.id);
    return HTTPSuccessResponse(res, 200, 'Connected trackers retrieved successfully', trackers);
  } catch (error) {
    return next(error);
  }
};

const getAuthorizeUrl = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tracker } = req.params as { tracker: string };
    const url = trackerService.getAuthUrl(req.user!.id, parseTracker(tracker));
    return HTTPSuccessResponse(res, 200, 'Authorize URL generated', { url });
  } catch (error) {
    return next(error);
  }
};

/**
 * The tracker redirects the user's browser straight here after they approve/deny. This is
 * a full-page navigation, not an XHR, so every outcome (including failure) must be a
 * redirect back into the app rather than JSON. `attachUser` has already run, so req.user
 * reflects the session cookie sent with the redirect.
 */
const handleCallback = async (req: Request, res: Response) => {
  const { tracker } = req.params as { tracker: string };
  const redirectBase = `${clientUrl()}/settings#account`;

  if (!req.user) {
    return res.redirect(
      `${redirectBase}?tracker_error=${encodeURIComponent('Please sign in first')}`,
    );
  }

  try {
    // The route has already parsed this query with trackerCallbackQuerySchema. Reading
    // req.query here would bypass any schema transforms/defaults added to that contract.
    const { code, state } = req.validated as TrackerCallbackQuery;
    await trackerService.handleCallback(req.user.id, parseTracker(tracker), code, state);
    return res.redirect(`${redirectBase}?tracker_connected=${encodeURIComponent(tracker)}`);
  } catch (error) {
    // Only messages written for users are echoed; anything else (driver, network) stays out of the URL.
    const message = error instanceof AppError ? error.message : "Couldn't connect that tracker";
    return res.redirect(`${redirectBase}?tracker_error=${encodeURIComponent(message)}`);
  }
};

/**
 * Manual "Sync now". The background poll only runs every 30 minutes and its per-cycle cap
 * means a given link may wait longer still. Runs inline rather than fire-and-forget: the UI
 * reports what actually happened, and the service already bounds the work.
 */
const syncNow = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await trackerService.syncNowForUser(req.user!.id);
    return HTTPSuccessResponse(res, 200, 'Trackers synced successfully', result);
  } catch (error) {
    return next(error);
  }
};

const disconnect = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tracker } = req.params as { tracker: string };
    await trackerService.disconnect(req.user!.id, parseTracker(tracker));
    return HTTPSuccessResponse(res, 200, 'Tracker disconnected successfully', null);
  } catch (error) {
    return next(error);
  }
};

const searchMedia = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tracker } = req.params as { tracker: string };
    const { query } = req.validated as TrackerSearchQuery;
    const results = await trackerService.searchMedia(req.user!.id, parseTracker(tracker), query);
    return HTTPSuccessResponse(res, 200, 'Search results retrieved successfully', results);
  } catch (error) {
    return next(error);
  }
};

const linkManga = async (req: Request, res: Response, next: NextFunction) => {
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

const unlinkManga = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { manga_id, tracker } = req.params as { manga_id: string; tracker: string };
    await trackerService.unlinkManga(req.user!.id, manga_id, parseTracker(tracker));
    return HTTPSuccessResponse(res, 200, 'Tracker link removed successfully', null);
  } catch (error) {
    return next(error);
  }
};

const trackerController = {
  listConnected,
  getAuthorizeUrl,
  handleCallback,
  syncNow,
  disconnect,
  searchMedia,
  linkManga,
  unlinkManga,
};

export default trackerController;
