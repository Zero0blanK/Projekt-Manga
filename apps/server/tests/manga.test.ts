import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';

// Adding a manga schedules a best-effort thumbnail fetch. That background HTTP work is
// outside this route/repository unit suite, so keep these tests deterministic and offline.
vi.mock('../src/workers/thumbnailSync.js', () => ({
  default: { enqueue: vi.fn() },
}));

import app from '../src/app.js';
import { prismaMock } from './mocks/prismaMock.js';

const now = new Date();
const sampleManga = {
  id: 'manga-1',
  slug: 'one-piece',
  title: 'One Piece',
  author: 'Oda',
  source: 'mangadex',
  thumbnail_url: 'https://example.com/thumb.jpg',
  // Library membership is a real column now: addManga only reports a duplicate for a row
  // that is already *in* the library, and adopts an out-of-library row instead. Without
  // this the fixture reads as a shadow row and takes the adoption path.
  in_library: true,
  created_at: now,
  updated_at: now,
};

describe('GET /api/manga', () => {
  it('returns the library listing with computed counts', async () => {
    prismaMock.manga.findMany.mockResolvedValueOnce([
      {
        ...sampleManga,
        _count: { chapter: 5 },
        chapter: [{ release_date: now }],
        manga_detail: null,
      },
    ]);
    prismaMock.chapter.groupBy.mockResolvedValueOnce([{ manga_id: 'manga-1', _count: { id: 2 } }]);

    const res = await request(app).get('/api/manga');

    expect(res.status).toBe(200);
    expect(res.body.data[0].chapter_count).toBe(5);
    expect(res.body.data[0].unread_count).toBe(2);
  });

  it('skips the unread-count query entirely when the library is empty', async () => {
    prismaMock.manga.findMany.mockResolvedValueOnce([]);

    const res = await request(app).get('/api/manga');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(prismaMock.chapter.groupBy).not.toHaveBeenCalled();
  });
});

describe('GET /api/manga/details/:manga_id', () => {
  it('404s when the manga does not exist', async () => {
    prismaMock.manga.findUnique.mockResolvedValueOnce(null);

    const res = await request(app).get('/api/manga/details/missing');

    expect(res.status).toBe(404);
  });

  it('flattens manga_detail into the response on success', async () => {
    prismaMock.manga.findUnique.mockResolvedValueOnce({
      ...sampleManga,
      manga_detail: {
        status: 'ONGOING',
        genres: 'Action, Adventure',
        description: 'A pirate crew.',
      },
      chapter: [],
    });

    const res = await request(app).get('/api/manga/details/manga-1');

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ONGOING');
    expect(res.body.data.chapters).toEqual([]);
  });
});

describe('POST /api/manga/add', () => {
  it('409s when a manga with the same title/slug already exists', async () => {
    prismaMock.manga.findFirst.mockResolvedValueOnce(sampleManga);

    const res = await request(app).post('/api/manga/add').send({
      source: 'mangadex',
      title: 'One Piece',
      slug: 'one-piece',
      thumbnail_url: 'https://example.com/thumb.jpg',
      description: '',
      genres: '',
      status: 'ONGOING',
      chapters: [],
    });

    expect(res.status).toBe(409);
    expect(prismaMock.manga.create).not.toHaveBeenCalled();
  });

  it('adopts an existing out-of-library row instead of reporting a duplicate', async () => {
    prismaMock.manga.findFirst.mockResolvedValueOnce({ ...sampleManga, in_library: false });
    prismaMock.manga.update.mockResolvedValueOnce({ ...sampleManga, in_library: true });

    const res = await request(app).post('/api/manga/add').send({
      source: 'mangadex',
      title: 'One Piece',
      slug: 'one-piece',
      thumbnail_url: 'https://example.com/thumb.jpg',
      description: '',
      genres: '',
      status: 'ONGOING',
      chapters: [],
    });

    expect(res.status).toBe(201);
    expect(prismaMock.manga.update).toHaveBeenCalled();
    expect(prismaMock.manga.create).not.toHaveBeenCalled();
  });

  it('fills placeholder chapter metadata when adopting a title without erasing reading progress', async () => {
    prismaMock.manga.findFirst.mockResolvedValueOnce({ ...sampleManga, in_library: false });
    prismaMock.manga.update.mockResolvedValueOnce({ ...sampleManga, in_library: true });
    prismaMock.chapter.findMany.mockResolvedValueOnce([
      {
        id: 'chapter-3',
        chapter_number: 0,
        url: '',
        name: '',
        scanlator: null,
        page_count: null,
        release_date: null,
      },
    ]);

    const res = await request(app)
      .post('/api/manga/add')
      .send({
        source: 'mangadex',
        title: 'One Piece',
        slug: 'one-piece',
        thumbnail_url: 'https://example.com/thumb.jpg',
        description: '',
        genres: '',
        status: 'ONGOING',
        chapters: [
          {
            id: 'chapter-3',
            chapter_number: 3,
            name: 'The middle',
            url: 'https://example.com/chapter-3',
            page_count: 20,
          },
        ],
      });

    expect(res.status).toBe(201);
    expect(prismaMock.chapter.update).toHaveBeenCalledWith({
      where: { id: 'chapter-3' },
      data: expect.objectContaining({
        chapter_number: 3,
        page_count: 20,
        name: 'The middle',
      }),
    });
    expect(prismaMock.chapter.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['chapter-3'] } },
      data: { manga_id: sampleManga.id },
    });
    expect(prismaMock.chapter.update.mock.calls[0][0].data).not.toHaveProperty('last_page_read');
  });

  it('scopes the duplicate check to the source, so the same title from another source is still added', async () => {
    // The Discover flow detects cross-source duplicates itself and offers "show entry",
    // "add to library anyway" and "migrate". The middle option is the one this protects:
    // while the lookup matched on title across every source, choosing it found the *other*
    // source's row, saw it was already in the library, and answered 409 — so the action
    // whose entire meaning is "yes, add it regardless" was the one that could not succeed.
    prismaMock.manga.findFirst.mockResolvedValueOnce(null);
    prismaMock.manga.create.mockResolvedValueOnce({
      ...sampleManga,
      id: 'manga-2',
      source: 'nhentai',
      slug: '677197',
    });
    prismaMock.manga_detail.create.mockResolvedValueOnce({});

    const res = await request(app).post('/api/manga/add').send({
      source: 'nhentai',
      title: 'One Piece',
      slug: '677197',
      thumbnail_url: 'https://example.com/thumb.jpg',
      description: '',
      genres: '',
      status: 'ONGOING',
      chapters: [],
    });

    expect(res.status).toBe(201);
    expect(prismaMock.manga.create).toHaveBeenCalled();
    // The assertion that actually pins the fix: the query has to be narrowed to this
    // source. Without it the same lookup would match the mangadex row above by title.
    expect(prismaMock.manga.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ source: 'nhentai' }) }),
    );
  });

  it('allows the same slug from a different source', async () => {
    prismaMock.manga.findFirst.mockResolvedValueOnce(null);
    prismaMock.manga.create.mockResolvedValueOnce({
      ...sampleManga,
      source: 'nhentai',
      slug: '677197',
    });
    prismaMock.manga_detail.create.mockResolvedValueOnce({});

    const res = await request(app).post('/api/manga/add').send({
      source: 'nhentai',
      title: 'Some Doujin',
      slug: '677197',
      thumbnail_url: 'https://example.com/thumb.jpg',
      description: '',
      genres: '',
      status: 'ONGOING',
      chapters: [],
    });

    expect(res.status).toBe(201);
    expect(prismaMock.manga.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ source: 'nhentai', slug: '677197' }),
      }),
    );
  });

  it('201s and maps an unrecognized status to UNKNOWN', async () => {
    prismaMock.manga.findFirst.mockResolvedValueOnce(null);
    prismaMock.manga.create.mockResolvedValueOnce(sampleManga);
    prismaMock.manga_detail.create.mockResolvedValueOnce({});

    const res = await request(app).post('/api/manga/add').send({
      source: 'mangadex',
      title: 'One Piece',
      slug: 'one-piece',
      thumbnail_url: 'https://example.com/thumb.jpg',
      description: '',
      genres: '',
      status: 'not-a-real-status',
      chapters: [],
    });

    expect(res.status).toBe(201);
    expect(prismaMock.manga_detail.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'UNKNOWN' }) }),
    );
  });
});

describe('DELETE /api/manga/:manga_id/delete', () => {
  it('404s without ever starting the delete transaction when the manga does not exist', async () => {
    prismaMock.manga.findFirst.mockResolvedValueOnce(null);

    const res = await request(app).delete('/api/manga/does-not-exist/delete');

    expect(res.status).toBe(404);
    // This is the regression check for the fixed bug: an unmatched id must never reach
    // the transaction that deletes/detaches rows scoped by `manga_id: undefined`.
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('runs the delete transaction when the manga exists', async () => {
    prismaMock.manga.findFirst.mockResolvedValue(sampleManga);
    prismaMock.history.findFirst.mockResolvedValueOnce(null);
    prismaMock.manga_category.deleteMany.mockResolvedValueOnce({ count: 0 });
    prismaMock.chapter.deleteMany.mockResolvedValueOnce({ count: 0 });
    prismaMock.manga_detail.deleteMany.mockResolvedValueOnce({ count: 1 });
    prismaMock.manga.deleteMany.mockResolvedValueOnce({ count: 1 });

    const res = await request(app).delete('/api/manga/manga-1/delete');

    expect(res.status).toBe(200);
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(prismaMock.manga.deleteMany).toHaveBeenCalledWith({ where: { id: 'manga-1' } });
  });
});

describe('DELETE /api/manga/:manga_id/delete scoping', () => {
  it('keeps the shared row when the shared library still has account entries', async () => {
    prismaMock.manga.findFirst.mockResolvedValue(sampleManga);
    prismaMock.user_library.count.mockResolvedValueOnce(2);
    prismaMock.manga.update.mockResolvedValueOnce({ ...sampleManga, in_library: false });

    const res = await request(app).delete('/api/manga/manga-1/delete');

    expect(res.status).toBe(200);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(prismaMock.manga.update).toHaveBeenCalledWith({
      where: { id: 'manga-1' },
      data: { in_library: false },
    });
  });
});

describe('POST /api/manga/:category_id/:manga_slug/add', () => {
  it('404s when the manga slug is not in the library', async () => {
    prismaMock.manga.findUnique.mockResolvedValueOnce(null);

    const res = await request(app).post('/api/manga/action/unknown-slug/add');

    expect(res.status).toBe(404);
  });

  it('links the manga to the category on success', async () => {
    prismaMock.manga.findFirst.mockResolvedValueOnce({ id: 'manga-1' });
    prismaMock.manga_category.create.mockResolvedValueOnce({
      manga_id: 'manga-1',
      category_id: 'action',
    });

    const res = await request(app).post('/api/manga/action/one-piece/add');

    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ manga_id: 'manga-1', category_id: 'action' });
  });
});

describe('GET /api/manga/category/:category_id', () => {
  it('returns manga in the category without manga_detail', async () => {
    prismaMock.manga_category.findMany.mockResolvedValueOnce([{ manga_id: 'manga-1' }]);
    prismaMock.manga.findMany.mockResolvedValueOnce([
      { ...sampleManga, _count: { chapter: 1 }, chapter: [] },
    ]);
    prismaMock.chapter.groupBy.mockResolvedValueOnce([]);

    const res = await request(app).get('/api/manga/category/action');

    expect(res.status).toBe(200);
    expect(res.body.data[0].id).toBe('manga-1');
  });
});
