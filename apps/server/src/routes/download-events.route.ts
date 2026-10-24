import { Router, Request, Response } from 'express';
import downloadWorker from '../workers/download.worker.js';

const router = Router();

/** Ceiling on simultaneous progress streams. Each one holds an open response plus three
 * worker listeners for as long as it lives, and nothing else bounds them. */
const MAX_EVENT_CLIENTS = 20;

const clients = new Set<Response>();

/**
 * Each connection adds one listener per event name, and Node warns past ten, which a few
 * browser tabs (or the desktop app alongside a browser) would exceed in normal use. The
 * listeners are removed on disconnect, so this raises a false alarm's threshold rather
 * than hiding a real leak.
 */
downloadWorker.setMaxListeners(MAX_EVENT_CLIENTS + 5);

router.get('/events', (_req: Request, res: Response) => {
  if (clients.size >= MAX_EVENT_CLIENTS) {
    res.status(503).json({
      success: false,
      message: 'Too many open download event streams',
    });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();

  res.write(`event: connected\ndata: ${JSON.stringify(downloadWorker.getStatus())}\n\n`);

  clients.add(res);

  const onProgress = (data: unknown) => {
    res.write(`event: progress\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const onComplete = (downloadId: string) => {
    res.write(`event: complete\ndata: ${JSON.stringify({ downloadId })}\n\n`);
  };

  const onFailed = (downloadId: string) => {
    res.write(`event: failed\ndata: ${JSON.stringify({ downloadId })}\n\n`);
  };

  downloadWorker.on('progress', onProgress);
  downloadWorker.on('complete', onComplete);
  downloadWorker.on('failed', onFailed);

  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 15_000);

  _req.on('close', () => {
    clearInterval(heartbeat);
    downloadWorker.off('progress', onProgress);
    downloadWorker.off('complete', onComplete);
    downloadWorker.off('failed', onFailed);
    clients.delete(res);
  });
});

export function closeAllDownloadEventClients(): void {
  for (const client of clients) {
    client.end();
  }
  clients.clear();
}

export default router;
