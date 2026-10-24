import { describe, expect, it } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import prisma from '../../src/configs/prisma.config.js';
import storage from '../../src/utils/storage.js';

const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');

describe('cached thumbnail serving (real SQLite and filesystem)', () => {
  it('serves a private cached file through the API without changing the source URL', async () => {
    const manga = await prisma.manga.create({
      data: {
        slug: 'cached-cover-fixture',
        title: 'Cached Cover Fixture',
        author: 'Fixture',
        source: 'fixture',
        thumbnail_url: 'https://example.com/source.png',
      },
    });
    const cachedPath = await storage.uploadBuffer(png, `${manga.id}-fixture.png`);
    try {
      await prisma.cache.create({
        data: { manga_id: manga.id, thumbnail_url: cachedPath, sha256_url: 'fixture-sha' },
      });

      const response = await request(app).get(`/api/cache/thumbnail/${manga.id}`);

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/^image\/png/);
      expect(Buffer.from(response.body)).toEqual(png);
      expect((await prisma.manga.findUnique({ where: { id: manga.id } }))?.thumbnail_url).toBe(
        'https://example.com/source.png',
      );
    } finally {
      await storage.removeCachedThumbnail(cachedPath);
    }
  });
});
