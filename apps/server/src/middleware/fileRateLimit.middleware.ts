import rateLimit from 'express-rate-limit';
import { rateLimitBody } from '../utils/responseHandlers.js';

/**
 * Ceilings for the routes that send files: covers, downloaded pages and CBZ exports. They
 * stop one client reading files in a tight loop on a server reachable from a network.
 *
 * They're generous on purpose. A library page asks for every cover it shows at once, the
 * reader preloads pages ahead, and the desktop app and Next's image loader reach the server
 * from one address for everyone.
 */
export const THUMBNAIL_REQUEST_LIMIT = 1500;
export const PAGE_REQUEST_LIMIT = 600;
export const CBZ_REQUEST_LIMIT = 30;

const message = rateLimitBody('Too many file requests — please try again shortly.');

export const thumbnailRateLimit = rateLimit({
  windowMs: 30 * 1000,
  limit: THUMBNAIL_REQUEST_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
  message,
});

export const pageRateLimit = rateLimit({
  windowMs: 30 * 1000,
  limit: PAGE_REQUEST_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
  message,
});

/** A CBZ export reads and zips a whole chapter, so it gets a much lower ceiling. */
export const cbzRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: CBZ_REQUEST_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
  message,
});
