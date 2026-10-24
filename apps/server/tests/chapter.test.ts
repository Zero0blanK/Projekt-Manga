import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import { prismaMock } from './mocks/prismaMock.js';

describe('GET /api/chapter/:manga_slug', () => {
  it('404s (not 500) when the manga does not exist', async () => {
    // Regression check: getChapter used to throw MangaNotFoundError inside its own try
    // block, which its own catch then rewrapped into a generic 500 PrismaError.
    prismaMock.manga.findFirst.mockResolvedValueOnce(null);

    const res = await request(app).get('/api/chapter/does-not-exist');

    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/manga/i);
  });

  it('200s with the chapter list when the manga exists', async () => {
    prismaMock.manga.findFirst.mockResolvedValueOnce({ id: 'manga-1' });
    prismaMock.chapter.findMany.mockResolvedValueOnce([{ id: 'ch-1', chapter_number: 1 }]);

    const res = await request(app).get('/api/chapter/one-piece');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it('scopes a chapter-list lookup to the requested source', async () => {
    prismaMock.manga.findFirst.mockResolvedValueOnce({ id: 'manga-2' });
    prismaMock.chapter.findMany.mockResolvedValueOnce([]);
    const res = await request(app).get('/api/chapter/shared-slug?source=source-b');
    expect(res.status).toBe(200);
    expect(prismaMock.manga.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { source: 'source-b', slug: 'shared-slug' } }),
    );
  });
});

describe('POST /api/chapter/:manga_slug/:chapter_id/mark-read', () => {
  it('marks an existing chapter as read', async () => {
    prismaMock.chapter.findUnique.mockResolvedValueOnce({ id: 'ch-1', is_read: false });
    prismaMock.manga.findUnique.mockResolvedValueOnce({ id: 'manga-1' });
    prismaMock.chapter.updateMany.mockResolvedValueOnce({ count: 1 });

    const res = await request(app).post('/api/chapter/one-piece/ch-1/mark-read').send({});

    expect(res.status).toBe(200);
    expect(prismaMock.chapter.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'ch-1' },
        data: expect.objectContaining({ is_read: true }),
      }),
    );
  });

  it('creates a placeholder chapter first when it does not exist yet', async () => {
    prismaMock.chapter.findUnique.mockResolvedValueOnce({ id: 'ch-2', is_read: false });
    prismaMock.manga.findUnique.mockResolvedValueOnce({ id: 'manga-1' });
    prismaMock.chapter.updateMany.mockResolvedValueOnce({ count: 1 });

    const res = await request(app)
      .post('/api/chapter/one-piece/ch-2/mark-read')
      .send({ name: 'Chapter 2', chapter_number: 2 });

    expect(res.status).toBe(200);
    expect(prismaMock.chapter.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'ch-2' }, update: {} }),
    );
  });
});

describe('POST /api/chapter/:manga_slug/:chapter_id/:last_page_read/mark-by-page', () => {
  it('repairs a source-only placeholder chapter number without adding the manga to the library', async () => {
    prismaMock.chapter.findUnique.mockResolvedValueOnce({
      id: 'source-chapter',
      chapter_number: 0,
      is_read: false,
    });
    prismaMock.manga.findUnique.mockResolvedValueOnce(null);

    const res = await request(app)
      .post('/api/chapter/source-title/source-chapter/4/mark-by-page')
      .send({ chapter_number: 12, page_count: 20 });

    expect(res.status).toBe(200);
    expect(prismaMock.chapter.updateMany).toHaveBeenCalledWith({
      where: { id: 'source-chapter', chapter_number: 0 },
      data: { chapter_number: 12 },
    });
    expect(prismaMock.manga.create).not.toHaveBeenCalled();
  });

  it('400s on a non-numeric last_page_read without calling the service', async () => {
    const res = await request(app)
      .post('/api/chapter/one-piece/ch-1/not-a-number/mark-by-page')
      .send({});

    expect(res.status).toBe(400);
    expect(prismaMock.chapter.updateMany).not.toHaveBeenCalled();
  });

  it('accepts a numeric last_page_read', async () => {
    prismaMock.chapter.findUnique.mockResolvedValueOnce({ id: 'ch-1', is_read: false });
    prismaMock.manga.findUnique.mockResolvedValueOnce({ id: 'manga-1' });
    prismaMock.chapter.updateMany.mockResolvedValueOnce({ count: 1 });

    const res = await request(app).post('/api/chapter/one-piece/ch-1/12/mark-by-page').send({});

    expect(res.status).toBe(200);
    expect(prismaMock.chapter.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ last_page_read: 12 }) }),
    );
  });
});

describe('GET /api/chapter/recent', () => {
  it('returns the global recent-chapters list (route no longer shadowed by /:manga_slug)', async () => {
    prismaMock.chapter.findMany.mockResolvedValueOnce([
      { id: 'ch-1', manga: { title: 'One Piece' } },
    ]);

    const res = await request(app).get('/api/chapter/recent');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });
});

describe('GET /api/chapter/status/:chapter_id', () => {
  it('returns read status', async () => {
    prismaMock.chapter.findUnique.mockResolvedValueOnce({ is_read: true });

    const res = await request(app).get('/api/chapter/status/ch-1');

    expect(res.status).toBe(200);
    expect(res.body.data.is_read).toBe(true);
  });
});
