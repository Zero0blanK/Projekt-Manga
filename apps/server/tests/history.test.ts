import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import { prismaMock } from './mocks/prismaMock.js';

describe('GET /api/history', () => {
  it('uses the linked manga title and cover for an old id-labelled history row', async () => {
    prismaMock.history.findMany.mockResolvedValueOnce([
      {
        id: 'history-1',
        source: 'source-a',
        manga_id: 'manga-1',
        manga_slug: 'slug-1',
        title: 'manga-1',
        thumbnail_url: null,
        chapter_id: null,
        pages_read: 1,
        time_read: 0,
        last_read: new Date(),
        read_at: new Date(),
        manga: { title: 'Actual Manga Title', thumbnail_url: 'https://example.com/cover.jpg' },
        chapter: null,
      },
    ]);
    const res = await request(app).get('/api/history');
    expect(res.status).toBe(200);
    expect(res.body.data[0].title).toBe('Actual Manga Title');
    expect(res.body.data[0].thumbnail_url).toBe('https://example.com/cover.jpg');
  });

  it('returns the flattened history list', async () => {
    prismaMock.history.findMany.mockResolvedValueOnce([
      {
        source: 'mangadex',
        manga_id: 'manga-1',
        manga_slug: 'one-piece',
        chapter_id: 'ch-1',
        pages_read: 10,
        time_read: 500,
        last_read: new Date(),
        read_at: new Date(),
        thumbnail_url: null,
        manga: {
          slug: 'one-piece',
          title: 'One Piece',
          thumbnail_url: 'https://example.com/t.jpg',
          in_library: true,
        },
        chapter: {
          id: 'ch-1',
          name: 'Ch 1',
          chapter_number: 1,
          is_read: true,
          last_page_read: 10,
          page_count: 10,
        },
      },
    ]);

    const res = await request(app).get('/api/history');

    expect(res.status).toBe(200);
    expect(res.body.data[0].title).toBe('One Piece');
    expect(res.body.data[0].in_library).toBe(true);
    expect(prismaMock.history.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ last_read: 'desc' }, { id: 'desc' }],
      }),
    );
  });
});

describe('DELETE /api/history/delete/:id', () => {
  it('restricts anonymous deletion to anonymous history', async () => {
    prismaMock.history.deleteMany.mockResolvedValueOnce({ count: 0 });
    const res = await request(app).delete('/api/history/delete/someone-elses-id');
    expect(res.status).toBe(200);
    expect(prismaMock.history.deleteMany).toHaveBeenCalledWith({
      where: { id: 'someone-elses-id', user_id: null },
    });
  });
  it('advances the sync watermark with an account tombstone', async () => {
    prismaMock.session.findUnique.mockResolvedValueOnce({
      id: 'sess-1',
      user_id: 'user-1',
      expires_at: new Date(Date.now() + 60_000),
      user: { id: 'user-1', email: 'reader@example.com' },
    });
    prismaMock.history.updateMany.mockResolvedValueOnce({ count: 1 });

    const res = await request(app)
      .delete('/api/history/delete/hist-1')
      .set('Cookie', ['pm_session=sess-1']);

    expect(res.status).toBe(200);
    expect(prismaMock.history.updateMany).toHaveBeenCalledWith({
      where: { id: 'hist-1', user_id: 'user-1' },
      data: {
        deleted_at: expect.any(Date),
        last_read: expect.any(Date),
        sync_updated_at: expect.any(Date),
      },
    });
    const data = prismaMock.history.updateMany.mock.calls[0][0].data;
    expect(data?.deleted_at).toEqual(data?.last_read);
  });
});

describe('POST /api/history/add', () => {
  it('creates a new history row when none exists yet', async () => {
    prismaMock.manga.findUnique.mockResolvedValueOnce({ id: 'manga-1' });
    prismaMock.chapter.findFirst.mockResolvedValueOnce({ id: 'ch-1' });
    prismaMock.history.findFirst.mockResolvedValueOnce(null);
    prismaMock.history.create.mockResolvedValueOnce({ id: 'hist-1', manga_slug: 'one-piece' });

    const res = await request(app).post('/api/history/add').send({
      source: 'mangadex',
      manga_slug: 'one-piece',
      pages_read: 5,
    });

    expect(res.status).toBe(201);
    expect(prismaMock.history.create).toHaveBeenCalledOnce();
    expect(prismaMock.chapter.upsert).toHaveBeenCalledWith({
      where: { id: 'ch-1' },
      create: { id: 'ch-1', url: '', chapter_number: 0 },
      update: {},
    });
  });

  it('stores the source-native ID separately from the slug for Resume links', async () => {
    prismaMock.history.findFirst.mockResolvedValueOnce(null);
    prismaMock.history.create.mockResolvedValueOnce({ id: 'hist-source' });

    const res = await request(app).post('/api/history/add').send({
      source: 'source-a',
      manga_slug: 'catalog-slug',
      source_manga_id: 'native-id-42',
      chapter_id: 'chapter-42',
      pages_read: 4,
    });

    expect(res.status).toBe(201);
    expect(prismaMock.history.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          source: 'source-a',
          manga_slug: 'catalog-slug',
          source_manga_id: 'native-id-42',
        }),
      }),
    );
  });

  it('updates the existing history row (matched by resolved chapter_id) instead of duplicating it', async () => {
    prismaMock.manga.findUnique.mockResolvedValueOnce({ id: 'manga-1' });
    prismaMock.chapter.findFirst.mockResolvedValueOnce({ id: 'ch-1' });
    prismaMock.history.findFirst.mockResolvedValueOnce({ id: 'hist-1', time_read: 100 });
    prismaMock.history.update.mockResolvedValueOnce({ id: 'hist-1', time_read: 150 });

    const res = await request(app).post('/api/history/add').send({
      source: 'mangadex',
      manga_slug: 'one-piece',
      pages_read: 5,
      time_read: 50,
    });

    expect(res.status).toBe(201);
    expect(prismaMock.history.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'hist-1' } }),
    );
    expect(prismaMock.history.create).not.toHaveBeenCalled();
  });
});

describe('GET /api/history/:manga_slug', () => {
  it('returns history entries for the manga', async () => {
    prismaMock.history.findMany.mockResolvedValueOnce([{ id: 'hist-1', manga_slug: 'one-piece' }]);

    const res = await request(app).get('/api/history/one-piece');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });
});
