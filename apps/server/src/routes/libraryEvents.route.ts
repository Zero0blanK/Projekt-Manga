import { EventEmitter } from 'node:events';
import { Router, type NextFunction, type Request, type Response } from 'express';

/**
 * Tells every open app and browser tab on the same library that it changed.
 *
 * The desktop app and any browser read one library from this server; without this, a
 * chapter read in one only shows in the other after a reload. A successful write to
 * library data (titles, categories, chapter progress, history, sync, restore) announces
 * itself to the streams of the same identity: the account that made it, or the anonymous
 * library. The event carries no data, only "refetch".
 */

const MAX_STREAMS = 50;
const changes = new EventEmitter();
changes.setMaxListeners(MAX_STREAMS + 5);
const streams = new Set<Response>();

/** Whose library a request reads and writes: its account, or the anonymous one. */
const ownerOf = (req: Request) => (req.user?.id ? `user:${req.user.id}` : 'anonymous');

const LIBRARY_PATHS = /^\/api\/(manga|category|chapter|history|library|sync|restore)(\/|$)/;
const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Announces each successful library write once its response is sent. */
export function announceLibraryWrites(req: Request, res: Response, next: NextFunction) {
  if (WRITES.has(req.method) && LIBRARY_PATHS.test(req.originalUrl.split('?')[0])) {
    res.on('finish', () => {
      if (res.statusCode < 400) changes.emit('change', ownerOf(req));
    });
  }
  next();
}

const router = Router();

router.get('/stream', (req: Request, res: Response) => {
  if (streams.size >= MAX_STREAMS) {
    res.status(503).json({ success: false, message: 'Too many open library streams' });
    return;
  }
  const owner = ownerOf(req);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  res.write('event: connected\ndata: {}\n\n');
  streams.add(res);

  // Several writes in a burst (a bulk mark-read) become one refetch.
  let pending: NodeJS.Timeout | null = null;
  const onChange = (changed: string) => {
    if (changed !== owner || pending) return;
    pending = setTimeout(() => {
      pending = null;
      res.write('event: change\ndata: {}\n\n');
    }, 300);
  };
  changes.on('change', onChange);
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    if (pending) clearTimeout(pending);
    changes.off('change', onChange);
    streams.delete(res);
  });
});

export function closeAllLibraryEventStreams(): void {
  for (const stream of streams) stream.end();
  streams.clear();
}

export default router;
