import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('axios', () => ({ default: { get: vi.fn() } }));
vi.mock('../src/utils/ssrfGuard.js', () => ({
  assertPublicHttpUrl: vi.fn(async (rawUrl: string) => new URL(rawUrl)),
  isDisallowedRedirectHost: vi.fn(() => false),
  guardedHttpAgent: {},
  guardedHttpsAgent: {},
  freshGuardedAgents: vi.fn(() => ({ httpAgent: {}, httpsAgent: {} })),
}));

import axios from 'axios';
import { IMAGE_PROXY_REQUEST_LIMIT } from '../src/routes/source.route.js';

const { default: app } = await import('../src/app.js');

describe('image proxy recovery', () => {
  it('does not spend the malformed-request quota on real cover images', async () => {
    expect(IMAGE_PROXY_REQUEST_LIMIT).toBeGreaterThan(60);
    const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
    vi.mocked(axios.get).mockImplementation(async () => ({
      status: 200,
      headers: {},
      data: Readable.from([png]),
    }));
    for (let attempt = 0; attempt < 61; attempt += 1) {
      const response = await request(app)
        .get('/api/source/image-proxy')
        .query({ url: `https://covers.example/${attempt}.png` });
      expect(response.status).toBe(200);
    }
  });

  it('passes a safe upstream rate-limit status and delay to the image optimizer', async () => {
    vi.mocked(axios.get).mockResolvedValueOnce({
      status: 429,
      headers: { 'retry-after': '30' },
      data: Readable.from([]),
    });
    const response = await request(app)
      .get('/api/source/image-proxy')
      .query({ url: 'https://covers.example/limited.png' });
    expect(response.status).toBe(429);
    expect(response.headers['retry-after']).toBe('30');
    expect(response.body.message).toMatch(/rate-limiting/);
  });
});
