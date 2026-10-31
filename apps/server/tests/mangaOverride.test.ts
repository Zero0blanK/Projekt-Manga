import { describe, it, expect, vi, afterEach } from 'vitest';
import request from 'supertest';

vi.mock('../src/utils/storage.js', () => ({
  default: {
    uploadBuffer: vi.fn(async (_buf: Buffer, key: string) => `/cache-assets/${key}`),
    removeCachedThumbnail: vi.fn().mockResolvedValue(undefined),
    resolveCachedThumbnail: vi.fn((url: string) => `C:/thumbs/${url.split('/').pop()}`),
    pruneOrphanedThumbnails: vi.fn().mockResolvedValue(0),
  },
}));

import app from '../src/app.js';
import storage from '../src/utils/storage.js';
import cacheService from '../src/services/cache.service.js';
import { prismaMock } from './mocks/prismaMock.js';
import { MANGA_COVER_MAX_BYTES } from '@projekt-manga/schemas';

const now = new Date('2026-10-28T12:00:00.000Z');
const manga = {
  id: 'manga-1',
  slug: 'one-piece',
  title: 'One Piece',
  author: 'Oda',
  source: 'mangadex',
  thumbnail_url: 'https://example.com/thumb.jpg',
  in_library: true,
  created_at: now,
  updated_at: now,
};
const detail = {
  id: 'detail-1',
  manga_id: 'manga-1',
  artist: 'Oda',
  description: 'Pirates.',
  genres: 'Action',
  status: 'ONGOING',
  rating: null,
  created_at: now,
  updated_at: now,
};
const override = (fields: Record<string, unknown> = {}) => ({
  id: 'override-1',
  manga_id: 'manga-1',
  user_id: null,
  title: null,
  author: null,
  description: null,
  status: null,
  cover_path: null,
  updated_at: now,
  ...fields,
});

function mockLoggedInSession(user_id = 'user-1') {
  prismaMock.session.findUnique.mockResolvedValueOnce({
    id: 'sess-1',
    user_id,
    expires_at: new Date(Date.now() + 60_000),
    user: { id: user_id, email: 'reader@example.com', display_name: null, created_at: now },
  });
}

const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(32)]);

afterEach(() => {
  vi.mocked(storage.uploadBuffer).mockClear();
  vi.mocked(storage.removeCachedThumbnail).mockClear();
});

describe('reads merge the override', () => {
  it('lays set fields over the catalog and keeps the originals beside them', async () => {
    prismaMock.manga.findUnique.mockResolvedValueOnce({
      ...manga,
      manga_detail: detail,
      chapter: [],
      cache: null,
    });
    prismaMock.manga_override.findFirst.mockResolvedValueOnce(
      override({ title: 'My Title', status: 'COMPLETED', cover_path: '/cache-assets/c.png' }),
    );

    const res = await request(app).get('/api/manga/details/manga-1');

    expect(res.status).toBe(200);
    expect(prismaMock.manga_override.findFirst).toHaveBeenCalledWith({
      where: { manga_id: 'manga-1', user_id: null },
    });
    expect(res.body.data).toMatchObject({
      title: 'My Title',
      author: 'Oda',
      description: 'Pirates.',
      status: 'COMPLETED',
      override: {
        title: 'My Title',
        author: null,
        status: 'COMPLETED',
        has_cover: true,
        original: { title: 'One Piece', author: 'Oda', status: 'ONGOING' },
      },
    });
    // The client is told there is a cover, never where the file lives.
    expect(JSON.stringify(res.body.data)).not.toContain('cache-assets');
  });

  it('returns override: null for an unedited title', async () => {
    prismaMock.manga.findUnique.mockResolvedValueOnce({
      ...manga,
      manga_detail: detail,
      chapter: [],
      cache: null,
    });

    const res = await request(app).get('/api/manga/details/manga-1');

    expect(res.body.data.title).toBe('One Piece');
    expect(res.body.data.override).toBeNull();
  });

  it('merges into the library listing for the anonymous identity', async () => {
    prismaMock.manga.findMany.mockResolvedValueOnce([
      { ...manga, _count: { chapter: 0 }, chapter: [], manga_detail: detail },
    ]);
    prismaMock.manga_override.findMany.mockResolvedValueOnce([
      override({ author: 'Eiichiro Oda', description: 'Mine.' }),
    ]);
    prismaMock.chapter.groupBy.mockResolvedValueOnce([]);

    const res = await request(app).get('/api/manga');

    expect(prismaMock.manga_override.findMany).toHaveBeenCalledWith({
      where: { manga_id: { in: ['manga-1'] }, user_id: null },
    });
    expect(res.body.data[0]).toMatchObject({
      title: 'One Piece',
      author: 'Eiichiro Oda',
      manga_detail: { description: 'Mine.', status: 'ONGOING' },
    });
  });

  it("reads an account's own overrides, not the anonymous ones", async () => {
    mockLoggedInSession('user-1');
    prismaMock.manga.findUnique.mockResolvedValueOnce({
      ...manga,
      manga_detail: detail,
      chapter: [],
      cache: null,
    });
    prismaMock.user_library.findUnique.mockResolvedValueOnce(null);

    await request(app).get('/api/manga/details/manga-1').set('Cookie', ['pm_session=sess-1']);

    expect(prismaMock.manga_override.findFirst).toHaveBeenCalledWith({
      where: { manga_id: 'manga-1', user_id: 'user-1' },
    });
  });
});

describe('PATCH /api/manga/:manga_id/override', () => {
  it('creates the anonymous row on first edit', async () => {
    prismaMock.manga.findFirst.mockResolvedValueOnce(manga);
    prismaMock.manga_override.findFirst.mockResolvedValueOnce(null);
    prismaMock.manga_override.create.mockResolvedValueOnce(override({ title: 'Mine' }));

    const res = await request(app).patch('/api/manga/manga-1/override').send({ title: ' Mine ' });

    expect(res.status).toBe(200);
    expect(prismaMock.manga_override.create).toHaveBeenCalledWith({
      data: { manga_id: 'manga-1', user_id: null, title: 'Mine' },
    });
    expect(res.body.data).toMatchObject({ title: 'Mine', has_cover: false });
    // Library updates and refreshes own the catalog; an edit never writes it.
    expect(prismaMock.manga.update).not.toHaveBeenCalled();
    expect(prismaMock.manga_detail.update).not.toHaveBeenCalled();
  });

  it("updates the signed-in account's own row", async () => {
    mockLoggedInSession('user-1');
    prismaMock.manga.findFirst.mockResolvedValueOnce(manga);
    prismaMock.manga_override.findFirst.mockResolvedValueOnce(
      override({ user_id: 'user-1', title: 'Old' }),
    );
    prismaMock.manga_override.update.mockResolvedValueOnce(
      override({ user_id: 'user-1', title: 'Old', status: 'HIATUS' }),
    );

    const res = await request(app)
      .patch('/api/manga/manga-1/override')
      .set('Cookie', ['pm_session=sess-1'])
      .send({ status: 'HIATUS' });

    expect(res.status).toBe(200);
    expect(prismaMock.manga_override.findFirst).toHaveBeenCalledWith({
      where: { manga_id: 'manga-1', user_id: 'user-1' },
    });
    expect(prismaMock.manga_override.update).toHaveBeenCalledWith({
      where: { id: 'override-1' },
      data: { status: 'HIATUS' },
    });
  });

  it('removes the row once every field is cleared', async () => {
    prismaMock.manga.findFirst.mockResolvedValueOnce(manga);
    prismaMock.manga_override.findFirst.mockResolvedValueOnce(override({ title: 'Mine' }));

    const res = await request(app).patch('/api/manga/manga-1/override').send({ title: null });

    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
    expect(prismaMock.manga_override.delete).toHaveBeenCalledWith({ where: { id: 'override-1' } });
  });

  it.each([
    [{}],
    [{ title: '   ' }],
    [{ status: 'FINISHED' }],
    [{ cover_path: '/cache-assets/x.png' }],
    [{ title: 'x'.repeat(256) }],
  ])('rejects %j', async (body) => {
    const res = await request(app).patch('/api/manga/manga-1/override').send(body);

    expect(res.status).toBe(400);
    expect(prismaMock.manga_override.create).not.toHaveBeenCalled();
  });

  it('404s for a title that does not exist', async () => {
    prismaMock.manga.findFirst.mockResolvedValueOnce(null);
    prismaMock.manga.findMany.mockResolvedValueOnce([]);

    const res = await request(app).patch('/api/manga/missing/override').send({ title: 'Mine' });

    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/manga/:manga_id/override', () => {
  it('drops the row and its cover file', async () => {
    prismaMock.manga.findFirst.mockResolvedValueOnce(manga);
    prismaMock.manga_override.findFirst.mockResolvedValueOnce(
      override({ title: 'Mine', cover_path: '/cache-assets/old.png' }),
    );

    const res = await request(app).delete('/api/manga/manga-1/override');

    expect(res.status).toBe(200);
    expect(prismaMock.manga_override.delete).toHaveBeenCalledWith({ where: { id: 'override-1' } });
    expect(storage.removeCachedThumbnail).toHaveBeenCalledWith('/cache-assets/old.png');
  });
});

describe('POST /api/manga/:manga_id/override/cover', () => {
  it('stores a valid image and replaces the previous cover', async () => {
    prismaMock.manga.findFirst.mockResolvedValueOnce(manga);
    prismaMock.manga_override.findFirst.mockResolvedValueOnce(
      override({ cover_path: '/cache-assets/old.png' }),
    );
    prismaMock.manga_override.update.mockImplementationOnce(async ({ data }) =>
      override({ ...data }),
    );

    const res = await request(app)
      .post('/api/manga/manga-1/override/cover')
      .send({ mime: 'image/png', data: png.toString('base64') });

    expect(res.status).toBe(200);
    expect(res.body.data.has_cover).toBe(true);
    const [buffer, key] = vi.mocked(storage.uploadBuffer).mock.calls[0];
    expect(buffer.equals(png)).toBe(true);
    expect(key).toMatch(/^[0-9a-f-]+\.png$/);
    expect(storage.removeCachedThumbnail).toHaveBeenCalledWith('/cache-assets/old.png');
  });

  it('refuses bytes that do not match the declared type', async () => {
    prismaMock.manga.findFirst.mockResolvedValueOnce(manga);

    const res = await request(app)
      .post('/api/manga/manga-1/override/cover')
      .send({ mime: 'image/jpeg', data: png.toString('base64') });

    expect(res.status).toBe(400);
    expect(storage.uploadBuffer).not.toHaveBeenCalled();
  });

  it('refuses a file that is not an image at all', async () => {
    prismaMock.manga.findFirst.mockResolvedValueOnce(manga);

    const res = await request(app)
      .post('/api/manga/manga-1/override/cover')
      .send({ mime: 'image/png', data: Buffer.from('<svg onload="x"/>').toString('base64') });

    expect(res.status).toBe(400);
    expect(storage.uploadBuffer).not.toHaveBeenCalled();
  });

  it('refuses a non-image MIME type', async () => {
    const res = await request(app)
      .post('/api/manga/manga-1/override/cover')
      .send({ mime: 'image/svg+xml', data: png.toString('base64') });

    expect(res.status).toBe(400);
  });

  it('refuses a cover over 5 MB', async () => {
    prismaMock.manga.findFirst.mockResolvedValueOnce(manga);
    const tooLarge = Buffer.concat([png, Buffer.alloc(MANGA_COVER_MAX_BYTES + 1 - png.length)]);

    const res = await request(app)
      .post('/api/manga/manga-1/override/cover')
      .send({ mime: 'image/png', data: tooLarge.toString('base64') });

    expect(res.status).toBe(413);
    expect(storage.uploadBuffer).not.toHaveBeenCalled();
  });

  it('refuses a multipart body, like every other write', async () => {
    const res = await request(app)
      .post('/api/manga/manga-1/override/cover')
      .attach('cover', png, 'cover.png');

    expect(res.status).toBe(415);
  });
});

describe('DELETE /api/manga/:manga_id/override/cover', () => {
  it('keeps the other edits and removes the file', async () => {
    prismaMock.manga.findFirst.mockResolvedValueOnce(manga);
    prismaMock.manga_override.findFirst.mockResolvedValueOnce(
      override({ title: 'Mine', cover_path: '/cache-assets/old.png' }),
    );
    prismaMock.manga_override.update.mockResolvedValueOnce(override({ title: 'Mine' }));

    const res = await request(app).delete('/api/manga/manga-1/override/cover');

    expect(res.status).toBe(200);
    expect(prismaMock.manga_override.update).toHaveBeenCalledWith({
      where: { id: 'override-1' },
      data: { cover_path: null },
    });
    expect(storage.removeCachedThumbnail).toHaveBeenCalledWith('/cache-assets/old.png');
  });
});

describe('covers and the thumbnail folder', () => {
  it('counts custom covers as referenced when pruning', async () => {
    prismaMock.cache.findMany.mockResolvedValueOnce([{ thumbnail_url: '/cache-assets/a.png' }]);
    prismaMock.manga_override.findMany.mockResolvedValueOnce([
      { cover_path: '/cache-assets/custom.png' },
    ]);

    await cacheService.pruneOrphanedThumbnails();

    expect(storage.pruneOrphanedThumbnails).toHaveBeenCalledWith(
      new Set(['/cache-assets/a.png', '/cache-assets/custom.png']),
    );
  });
});
