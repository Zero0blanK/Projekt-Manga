import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
    isAxiosError: (error: unknown) =>
      !!error && typeof error === 'object' && 'isAxiosError' in error,
  },
}));
vi.mock('../src/utils/ssrfGuard.js', () => ({
  assertPublicHttpUrl: vi.fn(async (rawUrl: string) => new URL(rawUrl)),
  isDisallowedRedirectHost: vi.fn(() => false),
  guardedHttpAgent: {},
  guardedHttpsAgent: {},
  freshGuardedAgents: vi.fn(() => ({ httpAgent: { fresh: true }, httpsAgent: { fresh: true } })),
}));

vi.mock('../src/services/sourceBrowserSession.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/sourceBrowserSession.service.js')>()),
  imageSessionHeaders: vi.fn(async () => ({})),
}));

import axios from 'axios';
import { imageSessionHeaders } from '../src/services/sourceBrowserSession.service.js';
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

  it("sends the source's saved browser session with its images", async () => {
    const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
    vi.mocked(imageSessionHeaders).mockResolvedValueOnce({
      Cookie: 'cf_clearance=abc',
      'User-Agent': 'Firefox UA',
    });
    vi.mocked(axios.get).mockResolvedValueOnce({
      status: 200,
      headers: {},
      data: Readable.from([png]),
    });

    const response = await request(app)
      .get('/api/source/image-proxy')
      .query({ url: 'https://manhuaus.com/cover.png', source_id: 'ManhuaUS' });

    expect(response.status).toBe(200);
    const [source, url] = vi.mocked(imageSessionHeaders).mock.calls.at(-1)!;
    expect(source).toBe('manhuaus');
    expect(String(url)).toBe('https://manhuaus.com/cover.png');
    const sent = vi.mocked(axios.get).mock.calls.at(-1)![1] as { headers: Record<string, string> };
    expect(sent.headers.Cookie).toBe('cf_clearance=abc');
    expect(sent.headers['User-Agent']).toBe('Firefox UA');
  });

  it("uses the source session's User-Agent even when no cookie matches", async () => {
    const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
    vi.mocked(imageSessionHeaders).mockResolvedValueOnce({ 'User-Agent': 'Firefox UA' });
    vi.mocked(axios.get).mockResolvedValueOnce({
      status: 200,
      headers: {},
      data: Readable.from([png]),
    });

    const response = await request(app)
      .get('/api/source/image-proxy')
      .query({ url: 'https://manhuaus.com/cover.png', source_id: 'ManhuaUS' });

    expect(response.status).toBe(200);
    const sent = vi.mocked(axios.get).mock.calls.at(-1)![1] as { headers: Record<string, string> };
    expect(sent.headers['User-Agent']).toBe('Firefox UA');
    expect(sent.headers).not.toHaveProperty('Cookie');
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

  it('answers 404 for an image the source deleted, and does not ask again', async () => {
    vi.mocked(axios.get).mockResolvedValueOnce({
      status: 404,
      headers: {},
      data: Readable.from(['not found']),
    });
    const url = 'https://cdn.example/deleted-cover.jpg';

    const first = await request(app).get('/api/source/image-proxy').query({ url });
    expect(first.status).toBe(404);
    const calls = vi.mocked(axios.get).mock.calls.length;

    const second = await request(app).get('/api/source/image-proxy').query({ url });
    expect(second.status).toBe(404);
    expect(vi.mocked(axios.get).mock.calls.length).toBe(calls);
  });

  it('answers 502 when the image host refuses the connection, without calling it a database error', async () => {
    vi.mocked(axios.get).mockRejectedValueOnce(
      Object.assign(new Error('write EPROTO handshake failure'), {
        isAxiosError: true,
        code: 'EPROTO',
      }),
    );
    const url = 'https://tls-broken.example/cover.jpg';

    const first = await request(app).get('/api/source/image-proxy').query({ url });
    expect(first.status).toBe(502);
    expect(first.body.message).toBe('The image host could not be reached');
    const calls = vi.mocked(axios.get).mock.calls.length;

    const second = await request(app).get('/api/source/image-proxy').query({ url });
    expect(second.status).toBe(502);
    expect(vi.mocked(axios.get).mock.calls.length).toBe(calls);
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
