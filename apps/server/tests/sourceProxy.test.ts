import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('axios', () => ({ default: { get: vi.fn() } }));
vi.mock('../src/utils/ssrfGuard.js', () => ({
  assertPublicHttpUrl: vi.fn(async (rawUrl: string) => new URL(rawUrl)),
  isDisallowedRedirectHost: vi.fn(() => false),
  guardedHttpAgent: {},
  guardedHttpsAgent: {},
  freshGuardedAgents: vi.fn(() => ({ httpAgent: { fresh: true }, httpsAgent: { fresh: true } })),
}));

import axios from 'axios';
import { prismaMock } from './mocks/prismaMock.js';

const { default: app } = await import('../src/app.js');

describe('GET /api/source/image-proxy', () => {
  it('retries a refused image once on a fresh connection', async () => {
    const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
    vi.mocked(axios.get)
      .mockResolvedValueOnce({ status: 403, headers: {}, data: Readable.from(['blocked']) })
      .mockResolvedValueOnce({ status: 200, headers: {}, data: Readable.from([png]) });

    const response = await request(app)
      .get('/api/source/image-proxy')
      .query({ url: 'https://cdn.example/page-1.png' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(png);
    const calls = vi.mocked(axios.get).mock.calls.slice(-2);
    expect(calls[0][1]).not.toHaveProperty('httpsAgent.fresh');
    expect(calls[1][1]).toHaveProperty('httpsAgent.fresh', true);
  });

  it('presents the installed source site as the Referer on the retry', async () => {
    const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
    prismaMock.installed_extension.findMany.mockResolvedValueOnce([
      { source_key: 'weebcentral', homepage: null, base_url: 'https://weebcentral.com' },
    ] as never);
    vi.mocked(axios.get)
      .mockResolvedValueOnce({ status: 403, headers: {}, data: Readable.from(['blocked']) })
      .mockResolvedValueOnce({ status: 200, headers: {}, data: Readable.from([png]) });

    const response = await request(app)
      .get('/api/source/image-proxy')
      .query({ url: 'https://cdn.example/page-3.png', source_id: 'weebcentral' });

    expect(response.status).toBe(200);
    const retry = vi.mocked(axios.get).mock.calls.at(-1)![1] as { headers: Record<string, string> };
    expect(retry.headers.Referer).toBe('https://weebcentral.com/');
  });

  it('answers an <img> request with an image-typed error so the browser does not block it', async () => {
    vi.mocked(axios.get)
      .mockResolvedValueOnce({ status: 403, headers: {}, data: Readable.from(['blocked']) })
      .mockResolvedValueOnce({ status: 403, headers: {}, data: Readable.from(['blocked']) });

    const response = await request(app)
      .get('/api/source/image-proxy')
      .set('Sec-Fetch-Dest', 'image')
      .query({ url: 'https://cdn.example/page-2.png' });

    expect(response.status).toBe(502);
    expect(response.headers['content-type']).toBe('image/png');
    expect(response.headers['x-proxy-error']).toBe('The source did not return a supported image');
  });

  it('streams a verified raster image with a fixed safe content type', async () => {
    const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
    vi.mocked(axios.get).mockResolvedValueOnce({
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
      data: Readable.from([png.subarray(0, 4), png.subarray(4)]),
    });

    const response = await request(app)
      .get('/api/source/image-proxy')
      .query({ url: 'https://covers.example/cover.png' });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('image/png');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.body).toEqual(png);
  });

  it('rejects an upstream response whose declared size exceeds the proxy ceiling', async () => {
    vi.mocked(axios.get).mockResolvedValueOnce({
      status: 200,
      headers: { 'content-type': 'image/png', 'content-length': String(10 * 1024 * 1024 + 1) },
      data: Readable.from([]),
    });

    const response = await request(app)
      .get('/api/source/image-proxy')
      .query({ url: 'https://covers.example/large.jpg' });

    expect(response.status).toBe(413);
    expect(response.body).toEqual({ success: false, message: 'Image response is too large' });
  });

  it.each(['text/html', 'image/svg+xml'])(
    'rejects %s instead of serving active content',
    async (type) => {
      vi.mocked(axios.get).mockResolvedValueOnce({
        status: 200,
        headers: { 'content-type': type },
        data: Readable.from(['<script>alert(1)</script>']),
      });

      const response = await request(app)
        .get('/api/source/image-proxy')
        .query({ url: 'https://covers.example/not-an-image' });

      expect(response.status).toBe(502);
      expect(response.headers['content-type']).toMatch(/application\/json/);
      expect(response.text).not.toContain('<script>');
    },
  );

  it('rejects an HTML body disguised as a PNG', async () => {
    vi.mocked(axios.get).mockResolvedValueOnce({
      status: 200,
      headers: { 'content-type': 'image/png' },
      data: Readable.from(['<script>alert(1)</script>']),
    });

    const response = await request(app)
      .get('/api/source/image-proxy')
      .query({ url: 'https://covers.example/fake.png' });

    expect(response.status).toBe(502);
  });

  it('rate-limits repeated image proxy requests from the same client', async () => {
    const clientIp = '203.0.113.23';
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const response = await request(app)
        .get('/api/source/image-proxy')
        .set('X-Forwarded-For', clientIp);
      expect(response.status).toBe(400);
    }

    const limited = await request(app)
      .get('/api/source/image-proxy')
      .set('X-Forwarded-For', clientIp);

    expect(limited.status).toBe(429);
    expect(limited.body.message).toMatch(/too many image requests/i);
  });
});
