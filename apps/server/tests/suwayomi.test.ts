import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';

vi.mock('../src/services/sandboxedSourceRegistry.service.js', () => ({
  getInstalledSandboxedSource: vi.fn(async () => undefined),
  getInstalledSandboxedSources: vi.fn(async () => []),
}));

import app from '../src/app.js';
import { setSuwayomiSettingsFileForTests } from '../src/services/suwayomi/settings.js';
import { resetSuwayomiRegistryForTests } from '../src/services/suwayomi/registry.js';
import { isSuwayomiImageUrl } from '../src/services/suwayomi/client.js';
import downloadService from '../src/services/download.service.js';
import {
  toFilterChanges,
  toMangaFilters,
  type SuwayomiFilter,
} from '../src/services/suwayomi/filters.js';

// A 1×1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

const FILTERS: SuwayomiFilter[] = [
  { __typename: 'HeaderFilter', name: 'Note' },
  {
    __typename: 'SelectFilter',
    name: 'Status',
    values: ['Any', 'Ongoing', 'Done'],
    selectDefault: 0,
  },
  { __typename: 'TextFilter', name: 'Author', textDefault: '' },
  { __typename: 'CheckBoxFilter', name: 'Completed only', checkDefault: false },
  {
    __typename: 'SortFilter',
    name: 'Sort',
    values: ['Views', 'Updated'],
    sortDefault: { index: 0, ascending: false },
  },
  {
    __typename: 'GroupFilter',
    name: 'Genres',
    filters: [
      { __typename: 'TriStateFilter', name: 'Action', triDefault: 'IGNORE' },
      { __typename: 'TriStateFilter', name: 'Romance', triDefault: 'IGNORE' },
    ],
  },
  {
    __typename: 'GroupFilter',
    name: 'Types',
    filters: [
      { __typename: 'CheckBoxFilter', name: 'Manga', checkDefault: true },
      { __typename: 'CheckBoxFilter', name: 'Manhwa', checkDefault: false },
    ],
  },
];

interface Seen {
  query: string;
  variables: Record<string, unknown>;
  authorization?: string;
}
const seen: Seen[] = [];
const imageAuth: Array<string | undefined> = [];
let server: http.Server;
let base: string;

function graphql(body: { query: string; variables: Record<string, unknown> }) {
  const { query, variables } = body;
  const extension = (installed: boolean) => ({
    pkgName: 'eu.kanade.tachiyomi.extension.en.example',
    name: 'Tachiyomi: Example',
    lang: 'en',
    versionName: '1.4.2',
    iconUrl: '/api/v1/extension/icon/example.apk',
    isNsfw: false,
    isInstalled: installed,
    hasUpdate: false,
    isObsolete: false,
  });
  if (query.includes('updateExtension')) return { updateExtension: { extension: extension(true) } };
  if (query.includes('fetchExtensions'))
    return {
      fetchExtensions: { extensions: [extension(false), { pkgName: '../bad', name: 'x' }] },
    };
  if (query.includes('extensions {')) return { extensions: { nodes: [extension(false)] } };
  if (query.includes('mangas(condition')) {
    return {
      mangas: {
        nodes: [
          {
            id: 10,
            sourceId: '1234567890123',
            title: 'In my library',
            thumbnailUrl: '/api/v1/manga/10/thumbnail',
            author: 'One',
            artist: null,
            description: null,
            genre: ['Action'],
            status: 'ONGOING',
            chapters: {
              nodes: [
                {
                  id: 5,
                  name: 'Ch. 1',
                  url: '/c',
                  chapterNumber: 1,
                  scanlator: null,
                  uploadDate: 1700000000000,
                  pageCount: 12,
                  isRead: true,
                  isBookmarked: false,
                  lastPageRead: 11,
                },
              ],
            },
          },
        ],
      },
    };
  }
  if (query.includes('aboutServer')) return { aboutServer: { name: 'Suwayomi', version: 'v2.4' } };
  if (query.includes('sources {')) {
    return {
      sources: {
        nodes: [
          {
            id: '1234567890123',
            name: 'Example',
            lang: 'en',
            iconUrl: '/api/v1/extension/icon/example.apk',
            isNsfw: false,
            supportsLatest: true,
            baseUrl: 'https://example.org',
          },
          { id: 'not-a-number', name: 'Broken', lang: 'en' },
        ],
      },
    };
  }
  if (query.includes('fetchSourceManga')) {
    const input = variables.input as { page: number; type: string };
    return {
      fetchSourceManga: {
        hasNextPage: input.page < 2,
        mangas: [
          {
            id: input.page * 10,
            title: `${input.type} ${input.page}`,
            thumbnailUrl: `/api/v1/manga/${input.page * 10}/thumbnail`,
          },
        ],
      },
    };
  }
  if (query.includes('source(id')) return { source: { filters: FILTERS } };
  if (query.includes('fetchManga(')) {
    const id = (variables.input as { id: number }).id;
    if (id === 404) throw new Error('No manga found');
    if (id === 403)
      throw new Error(
        'Exception while fetching data (/fetchManga) : Cloudflare bypass currently disabled java.io.IOException: Cloudflare bypass currently disabled at keiyoushi.b.t.a(Unknown Source)',
      );
    if (id === 500)
      throw new Error(
        'Exception while fetching data (/fetchManga) : java.io.IOException: HTTP error 500 at keiyoushi.b.t.a(Unknown Source) at eu.kanade.x(Unknown Source)',
      );
    return {
      fetchManga: {
        manga: {
          id,
          title: 'A title',
          thumbnailUrl: `/api/v1/manga/${id}/thumbnail`,
          url: '/series/a',
          realUrl: 'https://example.org/series/a',
          author: 'One, Two',
          artist: null,
          description: 'About',
          genre: ['Action'],
          status: 'ONGOING',
        },
      },
    };
  }
  if (query.includes('fetchChapters')) {
    return {
      fetchChapters: {
        chapters: [
          {
            id: 1,
            name: 'Ch. 1',
            url: '/c1',
            realUrl: null,
            chapterNumber: 1,
            scanlator: null,
            uploadDate: '1700000000000',
            sourceOrder: 1,
          },
          {
            id: 2,
            name: 'Ch. 2',
            url: '/c2',
            realUrl: null,
            chapterNumber: 2,
            scanlator: 'Team',
            uploadDate: 0,
            sourceOrder: 2,
          },
        ],
      },
    };
  }
  if (query.includes('fetchChapterPages')) {
    return {
      fetchChapterPages: {
        pages: ['/api/v1/manga/10/chapter/1/page/0', '/api/v1/manga/10/chapter/1/page/1'],
      },
    };
  }
  throw new Error('Unexpected query');
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/graphql') {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        const body = JSON.parse(raw) as Seen;
        seen.push({ ...body, authorization: req.headers.authorization });
        res.setHeader('Content-Type', 'application/json');
        try {
          res.end(JSON.stringify({ data: graphql(body) }));
        } catch (error) {
          res.end(JSON.stringify({ data: null, errors: [{ message: (error as Error).message }] }));
        }
      });
      return;
    }
    if (req.url?.startsWith('/api/v1/redirect')) {
      res.writeHead(302, { Location: 'http://203.0.113.1/' }).end();
      return;
    }
    if (req.url?.startsWith('/api/v1/')) {
      imageAuth.push(req.headers.authorization);
      if (req.url.includes('missing')) return void res.writeHead(404).end();
      if (req.url.includes('html')) return void res.writeHead(200).end('<html></html>');
      res.writeHead(200, { 'Content-Type': 'image/png' }).end(PNG);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

let root: string;
let file: string;
const originalKey = process.env.TOKEN_ENCRYPTION_KEY;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-suwayomi-'));
  file = path.join(root, 'suwayomi.json');
  setSuwayomiSettingsFileForTests(file);
  resetSuwayomiRegistryForTests();
  process.env.TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
  seen.length = 0;
  imageAuth.length = 0;
});

afterEach(async () => {
  setSuwayomiSettingsFileForTests(null);
  resetSuwayomiRegistryForTests();
  if (originalKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
  else process.env.TOKEN_ENCRYPTION_KEY = originalKey;
  delete process.env.ADMIN_TOKEN;
  await fs.rm(root, { recursive: true, force: true });
});

const connect = (body: Record<string, unknown> = {}) =>
  request(app)
    .put('/api/suwayomi/settings')
    .send({ enabled: true, url: base, ...body });

const SOURCE = 'suwayomi-1234567890123';

describe('Suwayomi settings', () => {
  it('needs the admin check', async () => {
    process.env.ADMIN_TOKEN = 'a-sixteen-char-token';
    const res = await request(app)
      .put('/api/suwayomi/settings')
      .set('X-Forwarded-For', '203.0.113.9')
      .send({ enabled: true, url: base });
    expect(res.status).toBe(403);
    await expect(fs.access(file)).rejects.toThrow();
  });

  it('keeps the password write-only and encrypted at rest', async () => {
    const saved = await connect({ username: 'reader', password: 'hunter2-secret' });
    expect(saved.status).toBe(200);
    expect(saved.body.data).toEqual({
      enabled: true,
      url: base,
      username: 'reader',
      has_password: true,
      password_readable: true,
    });
    expect(JSON.stringify(saved.body)).not.toContain('hunter2');
    expect(await fs.readFile(file, 'utf8')).not.toContain('hunter2');

    const read = await request(app).get('/api/suwayomi/settings');
    expect(read.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(read.body)).not.toContain('hunter2');

    // Kept when left out, and sent as basic auth.
    await connect({ username: 'reader' });
    await request(app).post('/api/suwayomi/test').expect(200);
    expect(seen.at(-1)?.authorization).toBe(
      `Basic ${Buffer.from('reader:hunter2-secret').toString('base64')}`,
    );
  });

  it('drops a saved password when the server URL changes', async () => {
    await connect({ username: 'reader', password: 'hunter2-secret' });
    const moved = await request(app)
      .put('/api/suwayomi/settings')
      .send({ enabled: true, url: 'http://127.0.0.1:1', username: 'reader' });
    expect(moved.body.data.has_password).toBe(false);
  });

  it('refuses a URL with credentials or a query', async () => {
    for (const url of [
      'http://user:pw@127.0.0.1:4567',
      'http://127.0.0.1:4567/?x=1',
      'ftp://host',
    ]) {
      expect((await connect({ url })).status).toBe(400);
    }
  });

  it('tests the connection', async () => {
    await connect();
    const res = await request(app).post('/api/suwayomi/test');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ name: 'Suwayomi', version: 'v2.4', sources: 1 });
  });

  it('reports an unreachable server safely', async () => {
    await connect({ url: 'http://127.0.0.1:1' });
    const res = await request(app).post('/api/suwayomi/test');
    expect(res.status).toBe(503);
    expect(res.body.message).toBe(
      'Nothing answered at http://127.0.0.1:1. Check that Suwayomi is running and that the address and port match its web interface.',
    );
  });
});

describe('Suwayomi sources', () => {
  beforeEach(async () => {
    await connect();
  });

  it('lists the server sources beside the extensions', async () => {
    const res = await request(app).get('/api/source/sources');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      {
        id: SOURCE,
        name: 'Example',
        lang: 'en',
        base_url: 'https://example.org',
        isNSFW: false,
        provider: 'suwayomi',
        icon_url: `${base}/api/v1/extension/icon/example.apk`,
      },
    ]);
  });

  it('lists nothing while it is turned off', async () => {
    await request(app).put('/api/suwayomi/settings').send({ enabled: false, url: base });
    expect((await request(app).get('/api/source/sources')).body.data).toEqual([]);
    expect((await request(app).get(`/api/source/${SOURCE}/capabilities`)).status).toBe(503);
  });

  it('pages popular and latest by Suwayomi page number', async () => {
    const first = await request(app).get(`/api/source/${SOURCE}/catalogue?category=popular`);
    expect(first.status).toBe(200);
    expect(first.body.data).toEqual({
      items: [
        {
          id: '10',
          slug: '10',
          title: 'POPULAR 1',
          source: SOURCE,
          thumbnail_url: `${base}/api/v1/manga/10/thumbnail`,
        },
      ],
      hasMore: true,
      nextCursor: '2',
    });
    const last = await request(app).get(`/api/source/${SOURCE}/catalogue?category=latest&cursor=2`);
    expect(last.body.data.items[0].title).toBe('LATEST 2');
    expect(last.body.data.hasMore).toBe(false);
    expect(last.body.data.nextCursor).toBeUndefined();
    expect((await request(app).get(`/api/source/${SOURCE}/catalogue?cursor=abc`)).status).toBe(400);
  });

  it('sends chosen filters as Suwayomi filter changes on a search', async () => {
    const filters = {
      f1: '2',
      f3: ['0'],
      f4: '1:asc',
      f5: { include: ['0'], exclude: ['1'] },
      f6: ['1'],
    };
    const res = await request(app).get(
      `/api/source/${SOURCE}/search-page?query=x&filters=${encodeURIComponent(JSON.stringify(filters))}`,
    );
    expect(res.status).toBe(200);
    const call = seen.find((entry) => entry.query.includes('fetchSourceManga'));
    expect(call?.variables.input).toEqual({
      source: '1234567890123',
      type: 'SEARCH',
      page: 1,
      query: 'x',
      filters: [
        { position: 1, selectState: 2 },
        { position: 3, checkBoxState: true },
        { position: 4, sortState: { index: 1, ascending: true } },
        { position: 5, groupChange: { position: 0, triState: 'INCLUDE' } },
        { position: 5, groupChange: { position: 1, triState: 'EXCLUDE' } },
        { position: 6, groupChange: { position: 0, checkBoxState: false } },
        { position: 6, groupChange: { position: 1, checkBoxState: true } },
      ],
    });
  });

  it('reads details with chapters newest first, and pages on the server', async () => {
    const details = await request(app).get(`/api/source/${SOURCE}/manga/10`);
    expect(details.status).toBe(200);
    expect(details.body.data).toMatchObject({
      slug: '10',
      url: 'https://example.org/series/a',
      author: ['One', 'Two'],
      genres: ['Action'],
      status: 'ONGOING',
    });
    expect(details.body.data.chapters.map((c: { id: string }) => c.id)).toEqual(['2', '1']);
    expect(details.body.data.chapters[1].release_date).toBe(new Date(1700000000000).toISOString());

    const pages = await request(app).get(`/api/source/${SOURCE}/chapter/1/pages`);
    expect(pages.body.data.items).toEqual([
      { index: 0, image_url: `${base}/api/v1/manga/10/chapter/1/page/0` },
      { index: 1, image_url: `${base}/api/v1/manga/10/chapter/1/page/1` },
    ]);

    expect((await request(app).get(`/api/source/${SOURCE}/manga/not-an-id`)).status).toBe(404);
  });

  it('maps a Suwayomi error without leaking its URLs', async () => {
    const res = await request(app).get(`/api/source/${SOURCE}/manga/404`);
    expect(res.status).toBe(502);
    expect(res.body.message).toContain('No manga found');
    expect(res.body.message).not.toContain(base);
  });

  it('proxies images from the server, with its login, and nothing else', async () => {
    await connect({ username: 'reader', password: 'hunter2-secret' });
    const ok = await request(app)
      .get('/api/source/image-proxy')
      .query({ url: `${base}/api/v1/manga/10/thumbnail`, source_id: SOURCE });
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toBe('image/png');
    expect(imageAuth.at(-1)).toMatch(/^Basic /);

    // Another port on the same machine is not the Suwayomi server.
    const other = await request(app)
      .get('/api/source/image-proxy')
      .query({ url: 'http://127.0.0.1:1/api/v1/manga/1/thumbnail' });
    expect(other.status).toBe(400);
    // A path outside its image API, a redirect or a non-image is refused.
    expect(
      (
        await request(app)
          .get('/api/source/image-proxy')
          .query({ url: `${base}/api/graphql` })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .get('/api/source/image-proxy')
          .query({ url: `${base}/api/v1/redirect` })
      ).status,
    ).toBe(502);
    expect(
      (
        await request(app)
          .get('/api/source/image-proxy')
          .query({ url: `${base}/api/v1/html` })
      ).status,
    ).toBe(502);
    expect(
      (
        await request(app)
          .get('/api/source/image-proxy')
          .query({ url: `${base}/api/v1/missing` })
      ).status,
    ).toBe(404);
  });

  it('downloads a page from the server through its own client', async () => {
    const directory = path.join(root, 'downloads');
    await fs.mkdir(directory);
    downloadService.setDownloadDir(directory);
    await downloadService.downloadPageWithRetry(
      'download-1',
      `${base}/api/v1/manga/10/chapter/1/page/0`,
      1,
      'Chapter_1',
      new AbortController().signal,
      0,
    );
    expect(await fs.readFile(path.join(directory, 'Chapter_1', 'page_001.png'))).toEqual(PNG);
    // A page on any other local port still goes through the public guard and is refused.
    await expect(
      downloadService.downloadPageWithRetry(
        'download-1',
        'http://127.0.0.1:1/api/v1/manga/10/chapter/1/page/0',
        2,
        'Chapter_1',
        new AbortController().signal,
        0,
      ),
    ).rejects.toThrow();
  });

  it("explains Suwayomi's own Cloudflare refusal and drops Java stack traces", async () => {
    const blocked = await request(app).get(`/api/source/${SOURCE}/manga/403`);
    expect(blocked.status).toBe(503);
    expect(blocked.body.message).toContain('Turn on FlareSolverr');
    const failed = await request(app).get(`/api/source/${SOURCE}/manga/500`);
    expect(failed.body.message).toBe('Suwayomi: HTTP error 500');
  });

  it('answers 503 for a library title while the server is down', async () => {
    await connect({ url: 'http://127.0.0.1:1' });
    const res = await request(app).get(`/api/source/${SOURCE}/manga/10`);
    expect(res.status).toBe(503);
    expect(res.body.message).toBe('The Suwayomi server is not reachable');
  });
});

describe('Suwayomi extensions', () => {
  beforeEach(async () => {
    await connect();
  });

  it('lists every extension the server can install, refreshed on request', async () => {
    const res = await request(app).get('/api/suwayomi/extensions');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data).toEqual([
      {
        pkg_name: 'eu.kanade.tachiyomi.extension.en.example',
        name: 'Example',
        lang: 'en',
        version: '1.4.2',
        icon_url: `${base}/api/v1/extension/icon/example.apk`,
        is_nsfw: false,
        installed: false,
        has_update: false,
        obsolete: false,
      },
    ]);
    const refreshed = await request(app).get('/api/suwayomi/extensions?refresh=1');
    expect(refreshed.body.data).toHaveLength(1);
    expect(seen.at(-1)?.query).toContain('fetchExtensions');
  });

  it('installs through Suwayomi and drops the cached source list', async () => {
    await request(app).get('/api/source/sources');
    const before = seen.filter((entry) => entry.query.includes('sources {')).length;
    const res = await request(app)
      .post('/api/suwayomi/extensions/eu.kanade.tachiyomi.extension.en.example')
      .send({ action: 'install' });
    expect(res.status).toBe(200);
    expect(res.body.data.installed).toBe(true);
    expect(seen.at(-1)?.variables).toEqual({
      input: { id: 'eu.kanade.tachiyomi.extension.en.example', patch: { install: true } },
    });
    await request(app).get('/api/source/sources');
    expect(seen.filter((entry) => entry.query.includes('sources {')).length).toBe(before + 1);
  });

  it('refuses a bad package name or action, and non-admins', async () => {
    expect(
      (await request(app).post('/api/suwayomi/extensions/a%2F..').send({ action: 'install' }))
        .status,
    ).toBe(400);
    expect(
      (await request(app).post('/api/suwayomi/extensions/a.b').send({ action: 'delete' })).status,
    ).toBe(400);
    process.env.ADMIN_TOKEN = 'a-sixteen-char-token';
    expect(
      (await request(app).get('/api/suwayomi/extensions').set('X-Forwarded-For', '203.0.113.9'))
        .status,
    ).toBe(403);
  });
});

describe('Suwayomi library import', () => {
  beforeEach(async () => {
    await connect();
  });

  it('builds a merge restore with Suwayomi ids and read state', async () => {
    const { buildLibraryImport, fetchSuwayomiLibrary } =
      await import('../src/services/suwayomi/libraryImport.js');
    const backup = buildLibraryImport(await fetchSuwayomiLibrary(), null);
    expect(backup.mode).toBe('merge');
    expect(backup.manga[0]).toMatchObject({
      source: SOURCE,
      slug: '10',
      thumbnail_url: `${base}/api/v1/manga/10/thumbnail`,
    });
    expect(backup.manga[0].chapters[0]).toMatchObject({
      source_chapter_key: '5',
      is_read: true,
      last_page_read: 11,
    });
    expect(backup.library).toHaveLength(1);
  });

  it('needs the admin check', async () => {
    process.env.ADMIN_TOKEN = 'a-sixteen-char-token';
    const res = await request(app)
      .post('/api/suwayomi/import')
      .set('X-Forwarded-For', '203.0.113.9');
    expect(res.status).toBe(403);
  });
});

describe('Suwayomi helpers', () => {
  it('matches only image paths on the saved origin', () => {
    const connection = { baseUrl: 'http://127.0.0.1:4567' };
    expect(isSuwayomiImageUrl('http://127.0.0.1:4567/api/v1/manga/1/thumbnail', connection)).toBe(
      true,
    );
    expect(isSuwayomiImageUrl('http://127.0.0.1:4568/api/v1/manga/1/thumbnail', connection)).toBe(
      false,
    );
    expect(isSuwayomiImageUrl('http://localhost:4567/api/v1/manga/1/thumbnail', connection)).toBe(
      false,
    );
    expect(isSuwayomiImageUrl('http://127.0.0.1:4567/api/graphql', connection)).toBe(false);
    expect(isSuwayomiImageUrl('http://u:p@127.0.0.1:4567/api/v1/x', connection)).toBe(false);
    expect(isSuwayomiImageUrl('http://127.0.0.1:4567/api/v1/x', null)).toBe(false);
  });

  it('maps every filter type, dropping labels', () => {
    expect(toMangaFilters(FILTERS).map((filter) => [filter.value, filter.type])).toEqual([
      ['f1', 'select'],
      ['f2', 'input'],
      ['f3', 'checkbox'],
      ['f4', 'select'],
      ['f5', 'tri-state'],
      ['f6', 'multi'],
    ]);
  });

  it('ignores values of the wrong type or out of range, and defaults', () => {
    expect(
      toFilterChanges(FILTERS, {
        f1: '9',
        f2: 42 as unknown as string,
        f4: '0:desc',
        f5: { include: [] },
        nope: 'x',
      }),
    ).toEqual([]);
  });
});
