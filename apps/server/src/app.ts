import express from 'express';
import cookieParser from 'cookie-parser';
import { resolveTrustProxy } from './configs/env.js';
import authRoutes from './routes/auth.route.js';
import mangaRoutes from './routes/manga.route.js';
import categoryRoutes from './routes/category.route.js';
import chapterRoutes from './routes/chapter.route.js';
import historyRoutes from './routes/history.route.js';
import downloadRoutes from './routes/download.route.js';
import downloadEventsRoutes from './routes/download-events.route.js';
import sourceRoutes from './routes/source.route.js';
import cacheRoutes from './routes/cache.route.js';
import docsRoutes from './routes/docs.route.js';
import healthRoutes from './routes/health.route.js';
import libraryRoutes from './routes/library.route.js';
import updateLogRoutes from './routes/updateLog.route.js';
import syncRoutes from './routes/sync.route.js';
import extensionRepositoryRoutes from './routes/extensionRepository.route.js';
import trackerRoutes from './routes/tracker.route.js';
import restoreRoutes from './routes/restore.route.js';
import backupRoutes from './routes/backup.route.js';
import sourceNetworkRoutes from './routes/sourceNetwork.route.js';
import notificationChannelRoutes from './routes/notificationChannel.route.js';
import translateRoutes from './routes/translate.route.js';
import suwayomiRoutes from './routes/suwayomi.route.js';
import libraryEventsRoutes, { announceLibraryWrites } from './routes/libraryEvents.route.js';
import errorHandler from './middleware/error.middleware.js';
import { NotFoundError } from './utils/customErrors.js';
import captureUserAgent from './middleware/userAgent.middleware.js';
import { attachUser } from './middleware/auth.middleware.js';
import { initializeUserAgentRefresh } from './utils/userAgent.js';
import cors from 'cors';
import helmet from 'helmet';
import { MANGA_COVER_MAX_BYTES, RESTORE_UPLOAD_LIMIT_BYTES } from '@projekt-manga/schemas';
import requestId from './middleware/requestId.middleware.js';
import rejectCrossSiteWrites from './middleware/crossSite.middleware.js';

const app = express();

initializeUserAgentRefresh();

// This API serves JSON and one Swagger UI page, never app HTML, so the defaults are
// almost all appropriate as-is. Two exceptions:
//
// - contentSecurityPolicy is disabled because the only HTML here is swagger-ui-express's
//   bundled page, which loads its own inline styles and scripts and breaks under the
//   default CSP. A CSP on a JSON endpoint buys nothing anyway — there's no document for
//   a browser to apply it to.
// - crossOriginResourcePolicy is relaxed to cross-origin because apps/web is served from
//   a different origin (:3000 vs :4000) and proxied cover images are loaded directly by
//   the browser; the default 'same-origin' would have the browser block every one.
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }),
);

// '*' is spec-incompatible with credentialed (cookie) requests — sessions need an
// explicit origin. CLIENT_URL is required once auth is in use; falling back to
// 'http://localhost:3000' (this project's own dev default, see apps/desktop's
// DEFAULT_WEB_URL) rather than '*' so a missing env var fails closed instead of quietly
// disabling credentialed requests.
app.use(
  cors({
    origin: process.env.CLIENT_URL || 'http://localhost:3000',
    credentials: true,
    // Lets the page read a file download's name (the CBZ export). Nothing else.
    exposedHeaders: ['Content-Disposition'],
  }),
);

app.use(cookieParser());
app.use(requestId);
// Before any body parser: a cross-site form must be refused before its body is read.
// There is deliberately no urlencoded parser — this API speaks JSON only, and accepting
// form bodies is what let any website POST to it (see crossSite.middleware.ts).
app.use(rejectCrossSiteWrites);
app.use('/api/restore', express.json({ limit: RESTORE_UPLOAD_LIMIT_BYTES }));
// A custom cover arrives base64-encoded (4/3 of its size) inside JSON.
app.use(
  '/api/manga/:manga_id/override/cover',
  express.json({ limit: Math.ceil(MANGA_COVER_MAX_BYTES / 3) * 4 + 1024 }),
);
app.use(express.json({ limit: '5mb' }));
// Not a constant: this decides req.ip, which is the auth rate limiter's counting key. See
// resolveTrustProxy for why the default is `loopback` rather than a hop count.
app.set('trust proxy', resolveTrustProxy(process.env.TRUST_PROXY));
app.use(captureUserAgent);
app.use(attachUser);
app.use(announceLibraryWrites);

app.use('/api/auth', authRoutes);
app.use('/api/manga', mangaRoutes);
app.use('/api/category', categoryRoutes);
app.use('/api/chapter', chapterRoutes);
app.use('/api/history', historyRoutes);
// Mounted before downloadRoutes: downloadRoutes' catch-all GET /:downloadId would
// otherwise shadow GET /events at the same prefix and swallow every request to it.
app.use('/api/downloads', downloadEventsRoutes);
app.use('/api/downloads', downloadRoutes);
app.use('/api/source', sourceRoutes);
app.use('/api/cache', cacheRoutes);
app.use('/api/docs', docsRoutes);
app.use('/api/health', healthRoutes);
app.use('/api/library', libraryRoutes);
app.use('/api/update-log', updateLogRoutes);
app.use('/api/sync', syncRoutes);
app.use('/api/extensions', extensionRepositoryRoutes);
app.use('/api/trackers', trackerRoutes);
app.use('/api/restore', restoreRoutes);
app.use('/api/backup', backupRoutes);
app.use('/api/source-network', sourceNetworkRoutes);
app.use('/api/notification-channels', notificationChannelRoutes);
app.use('/api/translate', translateRoutes);
app.use('/api/suwayomi', suwayomiRoutes);
app.use('/api/library-events', libraryEventsRoutes);

// Without this an unknown path falls through to Express's HTML 404, which the JSON client
// can't read.
app.use('/api', (_req, _res, next) => next(new NotFoundError('API route not found')));

app.use(errorHandler);

export default app;
