import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { prismaMock } from './mocks/prismaMock.js';
import {
  CBZ_REQUEST_LIMIT,
  PAGE_REQUEST_LIMIT,
  THUMBNAIL_REQUEST_LIMIT,
} from '../src/middleware/fileRateLimit.middleware.js';

void prismaMock;
const { default: app } = await import('../src/app.js');

describe('file route rate limits', () => {
  it.each([
    ['/api/cache/thumbnail/m1', THUMBNAIL_REQUEST_LIMIT],
    ['/api/cache/legacy-thumbnail/s1/m1', THUMBNAIL_REQUEST_LIMIT],
    ['/api/downloads/chapter/c1/page/0', PAGE_REQUEST_LIMIT],
    ['/api/downloads/chapter/c1/cbz', CBZ_REQUEST_LIMIT],
  ])('limits %s', async (path, limit) => {
    const response = await request(app).get(path).set('X-Forwarded-For', '203.0.113.40');
    expect(response.headers['ratelimit-limit']).toBe(String(limit));
  });

  it('refuses page requests past the limit from the same client', async () => {
    const clientIp = '203.0.113.41';
    for (let attempt = 0; attempt < PAGE_REQUEST_LIMIT; attempt += 1) {
      const response = await request(app)
        .get('/api/downloads/chapter/c1/page/-1')
        .set('X-Forwarded-For', clientIp);
      expect(response.status).toBe(400);
    }

    const limited = await request(app)
      .get('/api/downloads/chapter/c1/page/-1')
      .set('X-Forwarded-For', clientIp);

    expect(limited.status).toBe(429);
    expect(limited.body.message).toMatch(/too many file requests/i);
  });
});
