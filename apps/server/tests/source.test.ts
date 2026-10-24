import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { prismaMock } from './mocks/prismaMock.js';

const { logError } = vi.hoisted(() => ({ logError: vi.fn(async () => undefined) }));
vi.mock('../src/services/updateLog.service.js', () => ({
  default: { logError, logNewChapters: vi.fn(async () => undefined) },
}));

const fakeSource = {
  id: 'fake-source',
  name: 'Fake Source',
  lang: 'en',
  base_url: 'https://fake-source.example',
  isNSFW: false,
  getCapabilities: vi.fn(async () => ({
    latest: true,
    search: true,
    filters: true,
    languageFilter: false,
    urlSearch: false,
    nativePagination: true,
  })),
  fetchMangaPage: vi.fn(async () => ({
    items: [{ id: 'm1', slug: 'm1', title: 'Manga 1', source: 'fake-source', thumbnail_url: '' }],
    hasMore: true,
    nextCursor: 'page:2',
  })),
  searchMangaPage: vi.fn(async () => ({ items: [], hasMore: false })),
  fetchManga: vi.fn(async () => [
    { id: 'm1', slug: 'm1', title: 'Manga 1', source: 'fake-source', thumbnail_url: '' },
  ]),
  searchManga: vi.fn(async () => []),
  fetchMangaDetails: vi.fn(async (mangaId: string) => ({
    id: mangaId,
    slug: mangaId,
    title: 'Manga 1',
    source: 'fake-source',
    thumbnail_url: '',
    description: '',
    genres: [],
    status: 'ONGOING',
    chapters: [],
  })),
  fetchChapters: vi.fn(async () => []),
  fetchChapterPages: vi.fn(async () => ({ items: [], total: 0 })),
  getFilters: vi.fn(async () => []),
  fetchMangaUpdates: vi.fn(async () => []),
};

vi.mock('../src/services/sandboxedSourceRegistry.service.js', () => ({
  getInstalledSandboxedSources: vi.fn(async () => [fakeSource]),
  getInstalledSandboxedSource: vi.fn(async (id: string) =>
    id === fakeSource.id ? fakeSource : undefined,
  ),
}));

// Imported after the mock so the controller/service pick up the mocked registry.
const { default: app } = await import('../src/app.js');

describe('native catalogue endpoints', () => {
  it('exposes validated capabilities and forwards cursors, category and filters', async () => {
    const capabilities = await request(app).get('/api/source/fake-source/capabilities');
    expect(capabilities.status).toBe(200);
    expect(capabilities.body.data.nativePagination).toBe(true);
    const response = await request(app)
      .get('/api/source/fake-source/catalogue')
      .query({
        category: 'popular',
        cursor: 'page:1',
        limit: 10,
        filters: JSON.stringify({ status: 'ongoing' }),
      });
    expect(response.status).toBe(200);
    expect(response.body.data.nextCursor).toBe('page:2');
    expect(fakeSource.fetchMangaPage).toHaveBeenLastCalledWith(
      'popular',
      { cursor: 'page:1', limit: 10 },
      { status: 'ongoing' },
    );
  });

  it('supports terminal searches with defaults', async () => {
    const response = await request(app)
      .get('/api/source/fake-source/search-page')
      .query({ query: 'title' });
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ items: [], hasMore: false });
    expect(fakeSource.searchMangaPage).toHaveBeenLastCalledWith(
      'title',
      { cursor: undefined, limit: 20 },
      {},
    );
  });

  it.each([
    { limit: 0 },
    { limit: 101 },
    { limit: 1.5 },
    { cursor: '' },
    { cursor: 'x'.repeat(1025) },
    { filters: '[]' },
  ])('rejects malformed catalogue input %j', async (query) => {
    const response = await request(app).get('/api/source/fake-source/catalogue').query(query);
    expect(response.status).toBe(400);
  });

  it.each([
    { items: [], hasMore: true, nextCursor: 'page:2' },
    { items: [{ id: 'm1', slug: 'm1', title: 'Title' }], hasMore: true },
    { items: [], hasMore: false, nextCursor: 'page:2' },
    { items: [{ id: 'm1', slug: 'm1', title: 'Title' }], hasMore: true, nextCursor: 'page:1' },
    { items: [{ id: '', slug: 'm1', title: 'Title' }], hasMore: false },
  ])('rejects invalid or stalled upstream page %j', async (page) => {
    fakeSource.fetchMangaPage.mockResolvedValueOnce(page as never);
    const response = await request(app)
      .get('/api/source/fake-source/catalogue')
      .query({ cursor: 'page:1' });
    expect(response.status).toBe(502);
  });

  it('preserves classified source failures and reports missing sources', async () => {
    fakeSource.searchMangaPage.mockRejectedValueOnce(
      Object.assign(new Error('Source blocked requests'), { code: 'BLOCKED' }),
    );
    expect((await request(app).get('/api/source/fake-source/search-page')).status).toBe(503);
    expect((await request(app).get('/api/source/missing/catalogue')).status).toBe(503);
  });

  it.each(['INVALID_CURSOR', 'INVALID_PAGINATION'])(
    'maps request-specific parser reason %s to 400',
    async (reason) => {
      fakeSource.fetchMangaPage.mockRejectedValueOnce(
        Object.assign(new Error('Private adapter details'), { code: 'PARSE_ERROR', reason }),
      );
      const response = await request(app)
        .get('/api/source/fake-source/catalogue')
        .query({ cursor: 'valid-length-but-wrong-scope' });
      expect(response.status).toBe(400);
      expect(response.body.message).toBe(
        'Invalid catalogue pagination. Restart the search or browse.',
      );
    },
  );

  it('keeps upstream next-link failures distinct from invalid client cursors', async () => {
    fakeSource.fetchMangaPage.mockRejectedValueOnce(
      Object.assign(new Error('Invalid catalogue next page'), { code: 'PARSE_ERROR' }),
    );
    const response = await request(app).get('/api/source/fake-source/catalogue');
    expect(response.status).toBe(502);
  });
});

describe('GET /api/source/sources', () => {
  it('lists the loaded sources without exposing their methods', async () => {
    const res = await request(app).get('/api/source/sources');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      {
        id: 'fake-source',
        name: 'Fake Source',
        lang: 'en',
        base_url: 'https://fake-source.example',
        isNSFW: false,
      },
    ]);
  });
});

describe('GET /api/source/:source_id/manga', () => {
  it('404s (ServiceUnavailableError) for an unknown source id', async () => {
    const res = await request(app).get('/api/source/does-not-exist/manga');

    expect(res.status).toBe(503);
  });

  it('delegates to the source and returns its manga list', async () => {
    const res = await request(app).get(
      '/api/source/fake-source/manga?category=latest&limit=10&offset=0',
    );

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(fakeSource.fetchManga).toHaveBeenCalledWith('latest', { limit: 10, offset: 0 }, {});
  });

  /**
   * The shape a source's classified failure arrives in — matched structurally by
   * `translateSourceError`, never by `instanceof`, because a repo-installed source's
   * error is rebuilt from IPC JSON (apps/extensions/sandbox/spawnSandboxedSource.ts) and
   * a bundled one comes from a dynamically imported module. This is what makes a blocked
   * source a 503 the UI can explain instead of a bare 500.
   */
  it('maps a classified BLOCKED source failure onto 503 and the source’s own message', async () => {
    fakeSource.fetchManga.mockRejectedValueOnce(
      Object.assign(new Error('Fake Source blocked this request (anti-bot protection).'), {
        name: 'SourceError',
        code: 'BLOCKED',
        sourceId: 'fake-source',
        statusCode: 403,
        reason: 'Cloudflare challenge',
      }),
    );

    const res = await request(app).get('/api/source/fake-source/manga?category=latest');

    expect(res.status).toBe(503);
    expect(res.body.message).toBe('Fake Source blocked this request (anti-bot protection).');
  });

  it('still reports an unclassified source failure as a generic 500', async () => {
    fakeSource.fetchManga.mockRejectedValueOnce(new Error('index.js:31 TypeError: x is not a fn'));

    const res = await request(app).get('/api/source/fake-source/manga?category=latest');

    expect(res.status).toBe(500);
    // The internal message must not reach the client.
    expect(res.body.message).toBe('Internal server error');
  });
});

describe('POST /api/source/:source_id/manga/:manga_slug/updates', () => {
  it('distinguishes a logged source failure from a successful empty check', async () => {
    prismaMock.manga.findFirst.mockResolvedValue(null);
    fakeSource.fetchMangaUpdates.mockRejectedValueOnce(new Error('source unavailable'));

    const response = await request(app).post('/api/source/fake-source/manga/m1/updates').send({});

    expect(response.status).toBe(200);
    expect(response.body.message).toBe('Manga update check failed');
    expect(response.body.data).toMatchObject({ newChapters: 0, failed: true });
    expect(logError).toHaveBeenCalledWith('fake-source', undefined, 'm1', expect.any(Error));
  });
});

describe('library update renumbering', () => {
  it('corrects stored chapter numbers the source now reports differently', async () => {
    prismaMock.manga.findFirst.mockResolvedValue({ id: 'lib-1', title: 'Manga 1' } as never);
    prismaMock.chapter.findMany.mockResolvedValue([
      { id: 'c1', chapter_number: 92, manga_id: 'lib-1' },
      { id: 'c2', chapter_number: 2, manga_id: 'lib-1' },
    ] as never);
    prismaMock.chapter.update.mockImplementation(((args: unknown) => args) as never);
    prismaMock.$transaction.mockResolvedValue([] as never);
    fakeSource.fetchMangaUpdates.mockResolvedValueOnce([
      { id: 'c1', url: '/c1', name: 'Episode 1', chapter_number: 1 },
      { id: 'c2', url: '/c2', name: 'Episode 2', chapter_number: 2 },
    ] as never);

    const response = await request(app).post('/api/source/fake-source/manga/m1/updates').send({});

    expect(response.status).toBe(200);
    expect(prismaMock.chapter.update).toHaveBeenCalledTimes(1);
    expect(prismaMock.chapter.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { chapter_number: 1 },
    });
  });
});

describe('library details refresh', () => {
  it('re-reads stale placeholder details during an update check', async () => {
    prismaMock.manga.findFirst.mockResolvedValue({ id: 'lib-1', title: 'Manga 1' } as never);
    prismaMock.chapter.findMany.mockResolvedValue([] as never);
    prismaMock.manga_detail.findUnique.mockResolvedValue({
      updated_at: new Date('2020-01-01'),
      description: '',
      manga: { author: 'Unknown' },
    } as never);
    prismaMock.$transaction.mockResolvedValue([] as never);
    fakeSource.fetchMangaDetails.mockResolvedValueOnce({
      id: 'm1',
      slug: 'm1',
      title: 'Manga 1',
      source: 'fake-source',
      thumbnail_url: 'https://fake-source.example/cover.jpg',
      description: 'A story.',
      author: ['Someone'],
      genres: ['Action', 'Drama'],
      status: 'COMPLETED',
      chapters: [],
    } as never);

    const response = await request(app)
      .post('/api/source/fake-source/manga/m1/updates')
      .send({ manga_id: 'lib-1' });

    expect(response.status).toBe(200);
    expect(response.body.data.thumbnail_url).toBe('https://fake-source.example/cover.jpg');
    expect(prismaMock.manga.update).toHaveBeenCalledWith({
      where: { id: 'lib-1' },
      data: { author: 'Someone', thumbnail_url: 'https://fake-source.example/cover.jpg' },
    });
    expect(prismaMock.manga_detail.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { manga_id: 'lib-1' },
        update: {
          artist: 'Unknown',
          description: 'A story.',
          genres: 'Action, Drama',
          status: 'COMPLETED',
        },
      }),
    );
  });

  it('leaves recently refreshed details alone', async () => {
    prismaMock.manga.findFirst.mockResolvedValue({ id: 'lib-1', title: 'Manga 1' } as never);
    prismaMock.chapter.findMany.mockResolvedValue([] as never);
    prismaMock.manga_detail.findUnique.mockResolvedValue({
      updated_at: new Date(),
      description: 'Known.',
      manga: { author: 'Someone' },
    } as never);
    prismaMock.manga_detail.upsert.mockClear();

    await request(app).post('/api/source/fake-source/manga/m1/updates').send({ manga_id: 'lib-1' });

    expect(prismaMock.manga_detail.upsert).not.toHaveBeenCalled();
  });
});

describe('source output validation', () => {
  // A source is third-party code from a user-added repository, and the sandbox only
  // constrains what it can *reach*, not what it returns. The `Promise<Mangas[]>` annotation
  // on the other side of the IPC boundary is erased at runtime, so without this these
  // values were an unchecked cast of arbitrary JSON into the API's responses.
  it('rejects malformed output as an upstream failure rather than serving it', async () => {
    fakeSource.fetchManga.mockResolvedValueOnce([
      // No id, and a title of the wrong type entirely.
      { slug: 'm1', title: { not: 'a string' }, source: 'fake-source' },
    ] as never);

    const res = await request(app).get('/api/source/fake-source/manga?category=latest');

    expect(res.status).toBe(502);
    // Names the source: with several installed, "which one is broken" is the first
    // question worth answering.
    expect(res.body.message).toMatch(/fake-source/);
  });

  it('still accepts the shapes real sources actually send', async () => {
    fakeSource.fetchManga.mockResolvedValueOnce([
      {
        id: 'm1',
        slug: 'm1',
        title: 'Manga 1',
        // `source` and `thumbnail_url` omitted, an extra field present — all three are
        // normal, and none of them is a reason to fail the request.
        extra_field_the_app_does_not_know_about: 42,
      },
    ] as never);

    const res = await request(app).get('/api/source/fake-source/manga?category=latest');

    expect(res.status).toBe(200);
    expect(res.body.data[0].id).toBe('m1');
    // Unknown keys pass through untouched rather than being stripped.
    expect(res.body.data[0].extra_field_the_app_does_not_know_about).toBe(42);
  });
});

describe('GET /api/source/image-proxy', () => {
  it('rejects a target URL that resolves to a private IP (SSRF guard)', async () => {
    const res = await request(app)
      .get('/api/source/image-proxy')
      .query({ url: 'http://127.0.0.1:9999/x' });

    expect(res.status).toBe(400);
  });

  it('rejects a missing url param', async () => {
    const res = await request(app).get('/api/source/image-proxy');

    expect(res.status).toBe(400);
  });
});
