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

const KEY = {
  source_manga_slug_source_chapter_key: {
    source: 'src-a',
    manga_slug: 'one-piece',
    source_chapter_key: 'ch-1',
  },
};

describe('POST /api/chapter/:manga_slug/:source_chapter_key/mark-read', () => {
  it('marks the row the source key names, by its own id', async () => {
    prismaMock.manga.findUnique.mockResolvedValueOnce({ id: 'manga-1' });
    prismaMock.chapter.findUnique.mockResolvedValueOnce({
      id: 'row-1',
      manga_id: 'manga-1',
      chapter_number: 1,
    });
    prismaMock.chapter.updateMany.mockResolvedValueOnce({ count: 1 });

    const res = await request(app)
      .post('/api/chapter/one-piece/ch-1/mark-read')
      .send({ source: 'src-a' });

    expect(res.status).toBe(200);
    expect(prismaMock.chapter.findUnique).toHaveBeenCalledWith({ where: KEY });
    expect(prismaMock.chapter.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'row-1' },
        data: expect.objectContaining({ is_read: true }),
      }),
    );
  });

  it('creates a placeholder row for a key nothing has stored yet', async () => {
    prismaMock.manga.findUnique.mockResolvedValueOnce(null);
    prismaMock.chapter.findUnique.mockResolvedValueOnce(null);
    prismaMock.chapter.create.mockResolvedValueOnce({ id: 'row-2', manga_id: null });
    prismaMock.chapter.updateMany.mockResolvedValueOnce({ count: 1 });

    const res = await request(app)
      .post('/api/chapter/one-piece/ch-2/mark-read')
      .send({ source: 'src-a', name: 'Chapter 2', chapter_number: 2 });

    expect(res.status).toBe(200);
    expect(prismaMock.chapter.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        source: 'src-a',
        manga_slug: 'one-piece',
        source_chapter_key: 'ch-2',
        manga_id: null,
        name: 'Chapter 2',
        chapter_number: 2,
      }),
    });
    expect(prismaMock.chapter.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'row-2' } }),
    );
  });

  it('400s when neither the request nor a stored title says which source it is', async () => {
    prismaMock.manga.findFirst.mockResolvedValueOnce(null);

    const res = await request(app).post('/api/chapter/unknown/ch-1/mark-read').send({});

    expect(res.status).toBe(400);
    expect(prismaMock.chapter.create).not.toHaveBeenCalled();
  });
});

describe('POST /api/chapter/:manga_slug/:source_chapter_key/:last_page_read/mark-by-page', () => {
  it('repairs a source-only placeholder chapter number without adding the manga to the library', async () => {
    prismaMock.manga.findUnique.mockResolvedValueOnce(null);
    prismaMock.chapter.findUnique.mockResolvedValueOnce({
      id: 'row-1',
      manga_id: null,
      chapter_number: 0,
    });
    prismaMock.chapter.update.mockResolvedValueOnce({ id: 'row-1', manga_id: null });

    const res = await request(app)
      .post('/api/chapter/source-title/source-chapter/4/mark-by-page')
      .send({ source: 'src-a', chapter_number: 12, page_count: 20 });

    expect(res.status).toBe(200);
    expect(prismaMock.chapter.update).toHaveBeenCalledWith({
      where: { id: 'row-1' },
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
    prismaMock.manga.findUnique.mockResolvedValueOnce({ id: 'manga-1' });
    prismaMock.chapter.findUnique.mockResolvedValueOnce({
      id: 'row-1',
      manga_id: 'manga-1',
      chapter_number: 1,
    });
    prismaMock.chapter.updateMany.mockResolvedValueOnce({ count: 1 });

    const res = await request(app)
      .post('/api/chapter/one-piece/ch-1/12/mark-by-page')
      .send({ source: 'src-a' });

    expect(res.status).toBe(200);
    expect(prismaMock.chapter.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'row-1' },
        data: expect.objectContaining({ last_page_read: 12 }),
      }),
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
