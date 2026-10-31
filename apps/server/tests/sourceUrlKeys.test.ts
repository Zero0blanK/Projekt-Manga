import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import './mocks/prismaMock.js';

const base = (id: string) => ({
  id,
  name: id,
  lang: 'en',
  base_url: `https://${id}.example`,
  isNSFW: false,
  fetchManga: vi.fn(async () => []),
  searchManga: vi.fn(async () => []),
});
const sources: Record<string, object> = {
  keyed: {
    ...base('keyed'),
    keysFromUrls: vi.fn(async ({ manga, chapters }: { manga: string[]; chapters: string[] }) => ({
      supported: true,
      manga: manga.map((url) => url.split('/').pop() || null),
      chapters: chapters.map((url) => url.split('/').pop() || null),
    })),
  },
  // A source whose sandbox answers with the wrong number of keys.
  misaligned: {
    ...base('misaligned'),
    keysFromUrls: vi.fn(async () => ({ supported: true, manga: [], chapters: ['x'] })),
  },
  plain: base('plain'),
};

vi.mock('../src/services/sandboxedSourceRegistry.service.js', () => ({
  getInstalledSandboxedSources: vi.fn(async () => Object.values(sources)),
  getInstalledSandboxedSource: vi.fn(async (id: string) => sources[id]),
}));

const { default: app } = await import('../src/app.js');

describe('POST /api/source/:source_id/keys-from-urls', () => {
  it("returns the source's keys in request order", async () => {
    const response = await request(app)
      .post('/api/source/keyed/keys-from-urls')
      .send({ manga: ['/manga/a'], chapters: ['/manga/a/c1', '/'] });
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      supported: true,
      manga: ['a'],
      chapters: ['c1', null],
    });
  });

  it('answers unsupported for sources without keyFromUrl or with a bad answer', async () => {
    for (const id of ['plain', 'misaligned']) {
      const response = await request(app)
        .post(`/api/source/${id}/keys-from-urls`)
        .send({ manga: ['/a'], chapters: [] });
      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({ supported: false, manga: [null], chapters: [] });
    }
  });

  it('validates the body', async () => {
    const tooMany = Array.from({ length: 5_001 }, (_, i) => `/c/${i}`);
    for (const body of [{ manga: [''] }, { chapters: tooMany }, { manga: 'x' }]) {
      const response = await request(app).post('/api/source/keyed/keys-from-urls').send(body);
      expect(response.status).toBe(400);
    }
  });

  it('reports an unknown source', async () => {
    const response = await request(app)
      .post('/api/source/nope/keys-from-urls')
      .send({ manga: ['/a'] });
    expect(response.status).toBe(503);
  });
});
