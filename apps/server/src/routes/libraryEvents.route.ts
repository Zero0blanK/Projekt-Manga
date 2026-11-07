import { Router, type NextFunction, type Request, type Response } from 'express';
import {
  announceLibraryChange,
  EVERYONE,
  onLibraryChange,
  type LibraryChangeScope,
} from '../utils/libraryChanges.js';
import { StreamLimiter } from '../utils/streamLimiter.js';
import { HTTPErrorResponse } from '../utils/responseHandlers.js';

/**
 * Tells every open app and browser tab on the same library that it changed.
 *
 * The desktop app and any browser read one library from this server; without this, a
 * chapter read in one only shows in the other after a reload. A successful write to
 * library data (titles, categories, chapter progress, history, sync, restore) announces
 * itself to the streams of the same identity: the account that made it, or the anonymous
 * library. Work that isn't a request (an update check, a finished download) announces
 * itself through `announceLibraryChange`. An event says only what kind of data changed.
 */

const MAX_STREAMS = 50;
const streams = new Set<Response>();
const perClient = new StreamLimiter();

/** Whose library a request reads and writes: its account, or the anonymous one. */
const ownerOf = (req: Request) => (req.user?.id ? `user:${req.user.id}` : 'anonymous');

const LIBRARY_PATHS = /^\/api\/(manga|category|chapter|history|library|sync|restore)(\/|$)/;
const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const PROGRESS_PATHS = /^\/api\/(chapter|history)(\/|$)/;

/** Announces each successful library write once its response is sent. */
export function announceLibraryWrites(req: Request, res: Response, next: NextFunction) {
  const path = req.originalUrl.split('?')[0];
  if (WRITES.has(req.method) && LIBRARY_PATHS.test(path)) {
    const scope: LibraryChangeScope = PROGRESS_PATHS.test(path) ? 'progress' : 'library';
    res.on('finish', () => {
      if (res.statusCode < 400) announceLibraryChange(ownerOf(req), scope);
    });
  }
  next();
}

const router = Router();

router.get('/stream', (req: Request, res: Response) => {
  if (streams.size >= MAX_STREAMS || !perClient.acquire(req.ip)) {
    HTTPErrorResponse(res, 503, 'Too many open library streams');
    return;
  }
  const owner = ownerOf(req);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    // no-transform: a compressing hop would hold events back until a buffer fills.
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  res.write('event: connected\ndata: {}\n\n');
  streams.add(res);

  // Several writes in a burst (a bulk mark-read) become one refetch.
  let pending: NodeJS.Timeout | null = null;
  let pendingScope: LibraryChangeScope = 'progress';
  const stopListening = onLibraryChange((changed, scope) => {
    if (changed !== owner && changed !== EVERYONE) return;
    if (scope === 'library') pendingScope = 'library';
    pending ??= setTimeout(() => {
      pending = null;
      res.write(`event: change\ndata: ${JSON.stringify({ scope: pendingScope })}\n\n`);
      pendingScope = 'progress';
    }, 300);
  });
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    if (pending) clearTimeout(pending);
    stopListening();
    streams.delete(res);
    perClient.release(req.ip);
  });
});

export function closeAllLibraryEventStreams(): void {
  for (const stream of streams) stream.end();
  streams.clear();
}

export default router;
