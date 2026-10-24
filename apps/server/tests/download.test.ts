import http from 'http';
import type { AddressInfo } from 'net';
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import { prismaMock } from './mocks/prismaMock.js';
import downloadWorker from '../src/workers/download.worker.js';

describe('GET /api/downloads/events (SSE)', () => {
  it('is reachable and not shadowed by the generic GET /:downloadId route', async () => {
    // Regression check for the fix in app.ts: downloadEventsRoutes must be mounted
    // before downloadRoutes, or GET /:downloadId swallows every request to /events.
    const server = app.listen(0);
    const { port } = server.address() as AddressInfo;

    try {
      const contentType = await new Promise<string | undefined>((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/api/downloads/events`, (res) => {
          resolve(res.headers['content-type']);
          res.destroy();
          req.destroy();
        });
        req.on('error', reject);
      });

      expect(contentType).toContain('text/event-stream');
    } finally {
      server.close();
    }
  });
});

describe('POST /api/downloads/chapter', () => {
  it('returns 503 and removes the pending record when the queue is full', async () => {
    const admission = vi.spyOn(downloadWorker, 'addToQueue').mockReturnValueOnce(false);
    prismaMock.manga.findFirst.mockResolvedValueOnce({ id: 'manga-1', source: 'mangadex' });
    prismaMock.chapter.findUnique.mockResolvedValueOnce({ id: 'ch-1', manga_id: 'manga-1' });
    prismaMock.download.create.mockResolvedValueOnce({ id: 'dl-1' });
    prismaMock.download.delete.mockResolvedValueOnce({ id: 'dl-1' });
    try {
      const res = await request(app)
        .post('/api/downloads/chapter')
        .send({
          sourceId: 'mangadex',
          mangaSlug: 'one-piece',
          mangaTitle: 'One Piece',
          chapter: { id: 'ch-1', chapter_number: 1 },
        });
      expect(res.status).toBe(503);
      expect(prismaMock.download.delete).toHaveBeenCalledWith({ where: { id: 'dl-1' } });
    } finally {
      admission.mockRestore();
    }
  });
  it('400s when chapter.id is missing', async () => {
    const res = await request(app)
      .post('/api/downloads/chapter')
      .send({ sourceId: 'mangadex', mangaSlug: 'one-piece', mangaTitle: 'One Piece', chapter: {} });

    expect(res.status).toBe(400);
  });

  it('404s when the manga is not in the library', async () => {
    prismaMock.manga.findFirst.mockResolvedValueOnce(null);

    const res = await request(app)
      .post('/api/downloads/chapter')
      .send({
        sourceId: 'mangadex',
        mangaSlug: 'missing-manga',
        mangaTitle: 'Missing',
        chapter: { id: 'ch-1', chapter_number: 1 },
      });

    expect(res.status).toBe(404);
  });

  it('backfills manga_id on a chapter that exists only as a history placeholder', async () => {
    // Regression check: a chapter created via the "ghost chapter" history flow has
    // manga_id: null. download.manga_id is a required column, so initiateDownload must
    // link it to the resolved manga rather than falling back to an empty string.
    prismaMock.manga.findFirst.mockResolvedValueOnce({ id: 'manga-1', source: 'mangadex' });
    prismaMock.chapter.findUnique.mockResolvedValueOnce({ id: 'ch-1', manga_id: null });
    prismaMock.chapter.update.mockResolvedValueOnce({ id: 'ch-1', manga_id: 'manga-1' });
    prismaMock.download.create.mockResolvedValueOnce({ id: 'dl-1' });

    const res = await request(app)
      .post('/api/downloads/chapter')
      .send({
        sourceId: 'mangadex',
        mangaSlug: 'one-piece',
        mangaTitle: 'One Piece',
        chapter: { id: 'ch-1', chapter_number: 1 },
      });

    expect(res.status).toBe(200);
    expect(prismaMock.chapter.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { manga_id: 'manga-1' } }),
    );
    expect(prismaMock.download.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ manga_id: 'manga-1' }) }),
    );
  });

  it('queues a download for an already-linked chapter', async () => {
    prismaMock.manga.findFirst.mockResolvedValueOnce({ id: 'manga-1', source: 'mangadex' });
    prismaMock.chapter.findUnique.mockResolvedValueOnce({ id: 'ch-1', manga_id: 'manga-1' });
    prismaMock.download.create.mockResolvedValueOnce({ id: 'dl-1' });

    const res = await request(app)
      .post('/api/downloads/chapter')
      .send({
        sourceId: 'mangadex',
        mangaSlug: 'one-piece',
        mangaTitle: 'One Piece',
        chapter: { id: 'ch-1', chapter_number: 1 },
      });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('PENDING');
    expect(prismaMock.chapter.update).not.toHaveBeenCalled();
  });
});

describe('POST /api/downloads/orphans/cleanup', () => {
  it('rejects malformed opaque folder ids before accessing the filesystem', async () => {
    const res = await request(app)
      .post('/api/downloads/orphans/cleanup')
      .send({ ids: ['../../private'] });

    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/downloads/:downloadId/pause', () => {
  it('404s when the download does not exist', async () => {
    prismaMock.download.findUnique.mockResolvedValueOnce(null);

    const res = await request(app).patch('/api/downloads/missing/pause');

    expect(res.status).toBe(404);
  });

  it('400s when the download already finished', async () => {
    prismaMock.download.findUnique.mockResolvedValueOnce({ id: 'dl-1', status: 'COMPLETED' });

    const res = await request(app).patch('/api/downloads/dl-1/pause');

    expect(res.status).toBe(400);
  });

  it('pauses an in-progress download', async () => {
    prismaMock.download.findUnique.mockResolvedValueOnce({ id: 'dl-1', status: 'IN_PROGRESS' });
    prismaMock.download.update.mockResolvedValueOnce({ id: 'dl-1', status: 'PENDING' });

    const res = await request(app).patch('/api/downloads/dl-1/pause');

    expect(res.status).toBe(200);
  });
});

describe('GET /api/downloads/stats', () => {
  it('summarizes downloads by status', async () => {
    prismaMock.download.findMany.mockResolvedValueOnce([
      { status: 'COMPLETED', file_path: 'x', manga: {}, chapter: {} },
      { status: 'FAILED', file_path: 'y', manga: {}, chapter: {} },
    ]);

    const res = await request(app).get('/api/downloads/stats');

    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(2);
    expect(res.body.data.completed).toBe(1);
    expect(res.body.data.failed).toBe(1);
    expect(res.body.data.storageLimit).toBe(10 * 1024 * 1024 * 1024);
  });
});

describe('GET /api/downloads/chapter/:chapterId/pages', () => {
  it('returns no pages (not an error) when the chapter has not finished downloading', async () => {
    prismaMock.download.findFirst.mockResolvedValueOnce({
      status: 'IN_PROGRESS',
      downloaded_path: null,
    });

    const res = await request(app).get('/api/downloads/chapter/ch-1/pages');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});

describe('downloaded page listing', () => {
  it('never exposes absolute disk paths to API clients', async () => {
    const { default: downloadService } = await import('../src/services/download.service.js');
    vi.spyOn(
      downloadService as unknown as { listDownloadedPageFiles: () => Promise<unknown> },
      'listDownloadedPageFiles',
    ).mockResolvedValueOnce({
      downloadPath: String.raw`C:\Users\someone\Downloads\ProjektManga\Title\Chapter_1`,
      files: ['page_001.jpg', 'page_002.jpg'],
    });
    const pages = await downloadService.getDownloadedChapterPages('ch-1');
    expect(pages).toEqual([
      { index: 0, retryable: true },
      { index: 1, retryable: true },
    ]);
    expect(JSON.stringify(pages)).not.toContain('Users');
  });
});
