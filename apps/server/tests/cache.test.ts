import { describe, it, expect, vi, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import crypto from 'node:crypto';
import request from 'supertest';
import app from '../src/app.js';
import { prismaMock } from './mocks/prismaMock.js';

vi.mock('axios', () => ({ default: { get: vi.fn() } }));
vi.mock('../src/utils/storage.js', () => ({
  default: {
    uploadBuffer: vi.fn().mockResolvedValue('/cache-assets/test.png'),
    removeCachedThumbnail: vi.fn().mockResolvedValue(undefined),
    resolveCachedThumbnail: vi.fn().mockReturnValue('C:/test/test.png'),
  },
}));
import axios from 'axios';
import storage from '../src/utils/storage.js';
import sourceService from '../src/services/source.service.js';

const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');

afterEach(() => {
  vi.mocked(axios.get).mockReset();
  vi.mocked(storage.uploadBuffer).mockClear();
  vi.mocked(storage.removeCachedThumbnail).mockClear();
});

describe('POST /api/cache/sync/:manga_id', () => {
  it('404s when the manga does not exist', async () => {
    prismaMock.manga.findFirst.mockResolvedValueOnce(null);

    const res = await request(app).post('/api/cache/sync/missing');

    expect(res.status).toBe(404);
  });

  it('rejects a source_thumbnail_url that resolves to a private IP (SSRF guard)', async () => {
    prismaMock.manga.findFirst.mockResolvedValueOnce({
      id: 'manga-1',
      thumbnail_url: 'https://example.com/x.jpg',
    });

    const res = await request(app)
      .post('/api/cache/sync/manga-1')
      .send({ source_thumbnail_url: 'http://169.254.169.254/latest/meta-data/' });

    expect(res.status).toBe(502);
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('caches the thumbnail but leaves manga.thumbnail_url pointing at the source', async () => {
    prismaMock.manga.findFirst.mockResolvedValueOnce({
      id: 'manga-1',
      thumbnail_url: 'https://example.com/x.jpg',
    });
    prismaMock.cache.findUnique.mockResolvedValueOnce(null);
    vi.mocked(axios.get).mockResolvedValueOnce({
      headers: { 'content-type': 'application/octet-stream' },
      data: Readable.from([png]),
    });
    prismaMock.cache.upsert.mockResolvedValueOnce({});

    const res = await request(app).post('/api/cache/sync/manga-1').send({});

    expect(res.status).toBe(200);
    expect(res.body.data.updated).toBe(true);
    // The cache row is written...
    expect(prismaMock.cache.upsert).toHaveBeenCalled();
    // ...but manga.thumbnail_url is NOT repointed at it. storage.uploadBuffer returns a
    // site-relative path under apps/server/public that nothing serves, and the image proxy
    // rejects anything that isn't absolute http(s) — repointing there replaced a working
    // cover with a permanently broken one. Revisit if the cache is ever served over http.
    expect(prismaMock.manga.update).not.toHaveBeenCalled();
  });

  it('does not rewrite an unchanged thumbnail during a forced refresh', async () => {
    prismaMock.manga.findFirst.mockResolvedValueOnce({
      id: 'manga-1',
      thumbnail_url: 'https://example.com/x.png',
    });
    prismaMock.cache.findUnique.mockResolvedValueOnce({
      manga_id: 'manga-1',
      thumbnail_url: '/cache-assets/old.png',
      sha256_url: crypto.createHash('sha256').update(png).digest('hex'),
    });
    vi.mocked(axios.get).mockResolvedValueOnce({ data: Readable.from([png]) });

    const res = await request(app).post('/api/cache/sync/manga-1').send({});

    expect(res.status).toBe(200);
    expect(res.body.data.updated).toBe(false);
    expect(storage.uploadBuffer).not.toHaveBeenCalled();
    expect(prismaMock.cache.upsert).not.toHaveBeenCalled();
  });

  it('removes the previous private file after a changed cover is persisted', async () => {
    prismaMock.manga.findFirst.mockResolvedValueOnce({
      id: 'manga-1',
      thumbnail_url: 'https://example.com/x.png',
    });
    prismaMock.cache.findUnique.mockResolvedValueOnce({
      manga_id: 'manga-1',
      thumbnail_url: '/cache-assets/old.png',
      sha256_url: 'old-hash',
    });
    vi.mocked(axios.get).mockResolvedValueOnce({ data: Readable.from([png]) });
    prismaMock.cache.upsert.mockResolvedValueOnce({});

    const res = await request(app).post('/api/cache/sync/manga-1').send({});

    expect(res.status).toBe(200);
    expect(res.body.data.updated).toBe(true);
    expect(storage.removeCachedThumbnail).toHaveBeenCalledWith('/cache-assets/old.png');
  });

  it('serializes simultaneous refreshes for one manga instead of creating duplicate files', async () => {
    prismaMock.manga.findFirst.mockResolvedValue({
      id: 'manga-1',
      thumbnail_url: 'https://example.com/x.png',
    });
    prismaMock.cache.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
      manga_id: 'manga-1',
      thumbnail_url: '/cache-assets/test.png',
      sha256_url: crypto.createHash('sha256').update(png).digest('hex'),
    });
    vi.mocked(axios.get)
      .mockResolvedValueOnce({ data: Readable.from([png]) })
      .mockResolvedValueOnce({ data: Readable.from([png]) });
    prismaMock.cache.upsert.mockResolvedValueOnce({});

    const [first, second] = await Promise.all([
      request(app).post('/api/cache/sync/manga-1').send({}),
      request(app).post('/api/cache/sync/manga-1').send({}),
    ]);

    expect([first.status, second.status]).toEqual([200, 200]);
    expect(storage.uploadBuffer).toHaveBeenCalledTimes(1);
  });

  it('stops an oversized chunked image before buffering or storing it', async () => {
    prismaMock.manga.findFirst.mockResolvedValueOnce({
      id: 'manga-1',
      thumbnail_url: 'https://example.com/x.png',
    });
    prismaMock.cache.findUnique.mockResolvedValueOnce(null);
    vi.mocked(axios.get).mockResolvedValueOnce({
      headers: { 'content-type': 'image/png' },
      data: Readable.from([png, Buffer.alloc(10 * 1024 * 1024)]),
    });

    const res = await request(app).post('/api/cache/sync/manga-1').send({});

    expect(res.status).toBe(413);
    expect(storage.uploadBuffer).not.toHaveBeenCalled();
  });

  it('does not store a response whose image header disguises HTML', async () => {
    prismaMock.manga.findFirst.mockResolvedValueOnce({
      id: 'manga-1',
      thumbnail_url: 'https://example.com/x.png',
    });
    prismaMock.cache.findUnique.mockResolvedValueOnce(null);
    vi.mocked(axios.get).mockResolvedValueOnce({
      headers: { 'content-type': 'image/png' },
      data: Readable.from(['<script>alert(1)</script>']),
    });

    const res = await request(app).post('/api/cache/sync/manga-1').send({});

    expect(res.status).toBe(502);
    expect(storage.uploadBuffer).not.toHaveBeenCalled();
  });

  it('does not re-fetch a row whose thumbnail_url is already a local cache path', async () => {
    prismaMock.manga.findFirst.mockResolvedValueOnce({
      id: 'manga-1',
      thumbnail_url: '/extension/thumbnails/manga-1-123.jpg',
    });

    const res = await request(app).post('/api/cache/sync/manga-1').send({});

    expect(res.status).toBe(400);
    expect(axios.get).not.toHaveBeenCalled();
  });
});

describe('GET /api/cache/status/:manga_id', () => {
  it('reports exists: false when there is no cache row', async () => {
    prismaMock.cache.findUnique.mockResolvedValueOnce(null);

    const res = await request(app).get('/api/cache/status/manga-1');

    expect(res.status).toBe(200);
    expect(res.body.data.exists).toBe(false);
  });
});

describe('GET /api/cache/thumbnail/:manga_id', () => {
  it('falls back to the guarded image proxy when no cached file exists', async () => {
    prismaMock.cache.findUnique.mockResolvedValueOnce(null);
    prismaMock.manga.findFirst.mockResolvedValueOnce({
      id: 'manga-1',
      source: 'fixture',
      thumbnail_url: 'https://example.com/cover.png',
    });

    const res = await request(app).get('/api/cache/thumbnail/manga-1');

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/api/source/image-proxy?');
  });

  it('falls back to the source when the cache row points to a missing file', async () => {
    prismaMock.cache.findUnique.mockResolvedValueOnce({
      manga_id: 'manga-1',
      thumbnail_url: '/cache-assets/missing.png',
    });
    prismaMock.manga.findFirst.mockResolvedValueOnce({
      id: 'manga-1',
      source: 'fixture',
      thumbnail_url: 'https://example.com/cover.png',
    });

    const res = await request(app).get('/api/cache/thumbnail/manga-1');

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/api/source/image-proxy?');
  });

  it('recovers a legacy public-thumbnail reference through the installed source', async () => {
    prismaMock.cache.findUnique.mockResolvedValueOnce(null);
    prismaMock.manga.findFirst.mockResolvedValueOnce({
      id: 'manga-legacy',
      slug: 'legacy-slug',
      source: 'fixture',
      thumbnail_url: '/extension/thumbnails/legacy.jpg',
    });
    const lookup = vi
      .spyOn(sourceService, 'getMangaThumbnail')
      .mockResolvedValueOnce('https://covers.example/recovered.jpg');

    try {
      const res = await request(app).get('/api/cache/thumbnail/manga-legacy');

      expect(res.status).toBe(302);
      const destination = new URL(res.headers.location, 'http://localhost');
      const proxyQuery = new URLSearchParams(destination.search);
      expect(destination.pathname).toBe('/api/source/image-proxy');
      expect(proxyQuery.get('url')).toBe('https://covers.example/recovered.jpg');
      expect(lookup).toHaveBeenCalledWith('fixture', 'legacy-slug');
    } finally {
      lookup.mockRestore();
    }
  });
});

describe('GET /api/cache/legacy-thumbnail/:source_id/:manga_id', () => {
  it('redirects an old history cover through the guarded image proxy', async () => {
    const lookup = vi
      .spyOn(sourceService, 'getMangaThumbnail')
      .mockResolvedValueOnce('https://covers.example/legacy.jpg');
    try {
      const res = await request(app).get('/api/cache/legacy-thumbnail/fixture/legacy-slug');

      expect(res.status).toBe(302);
      const destination = new URL(res.headers.location, 'http://localhost');
      const query = new URLSearchParams(destination.search);
      expect(destination.pathname).toBe('/api/source/image-proxy');
      expect(query.get('url')).toBe('https://covers.example/legacy.jpg');
      expect(lookup).toHaveBeenCalledWith('fixture', 'legacy-slug');
    } finally {
      lookup.mockRestore();
    }
  });

  it('does not redirect a non-HTTP thumbnail returned by an extension', async () => {
    const lookup = vi
      .spyOn(sourceService, 'getMangaThumbnail')
      .mockResolvedValueOnce('file:///etc/passwd');
    try {
      const res = await request(app).get('/api/cache/legacy-thumbnail/fixture/legacy-slug');
      expect(res.status).toBe(404);
    } finally {
      lookup.mockRestore();
    }
  });
});
