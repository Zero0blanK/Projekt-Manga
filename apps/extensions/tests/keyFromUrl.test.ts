import { describe, expect, it } from 'vitest';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import type { AxiosInstance } from 'axios';
import type { Source } from '@projekt-manga/types';
import { sourceUrlKeys, URL_KEYS_LIMIT } from '../sandbox/runner.js';
import { spawnSandboxedSource } from '../dist/sandbox/index.js';
import { createMadaraSource } from '../utils/madara.js';

const withKeys = {
  id: 'fixture',
  keyFromUrl: (url: string, kind: 'manga' | 'chapter') =>
    url === '/bad' ? '' : `${kind}:${url.split('/').filter(Boolean).at(-1)}`,
} as unknown as Source;

describe('sourceUrlKeys', () => {
  it('converts each URL in order and nulls what the source does not recognise', () => {
    expect(
      sourceUrlKeys(withKeys, { manga: ['/title/a'], chapters: ['/title/a/c1', '/bad', 5] }),
    ).toEqual({
      supported: true,
      manga: ['manga:a'],
      chapters: ['chapter:c1', null, null],
    });
  });

  it('reports a source without keyFromUrl as unsupported', () => {
    expect(sourceUrlKeys({ id: 'x' } as Source, { manga: ['/a'], chapters: [] })).toEqual({
      supported: false,
      manga: [null],
      chapters: [],
    });
  });

  it('refuses an oversized batch', () => {
    const chapters = Array.from({ length: URL_KEYS_LIMIT + 1 }, (_, i) => `/c/${i}`);
    expect(() => sourceUrlKeys(withKeys, { manga: [], chapters })).toThrow(/At most/);
  });
});

describe('Madara keyFromUrl', () => {
  const source = createMadaraSource({
    id: 'madara-fixture',
    name: 'Madara Fixture',
    lang: 'en',
    baseUrl: 'https://madara.invalid',
    isNSFW: false,
    api: {} as AxiosInstance,
  });

  it("turns Mihon's site paths into the keys the source itself parses", () => {
    expect(source.keyFromUrl!('/manga/solo-leveling/', 'manga')).toBe('solo-leveling');
    expect(source.keyFromUrl!('https://madara.invalid/manga/solo-leveling', 'manga')).toBe(
      'solo-leveling',
    );
    expect(source.keyFromUrl!('/manga/solo-leveling/chapter-12/?style=list', 'chapter')).toBe(
      'chapter-12',
    );
    expect(source.keyFromUrl!('/about/', 'manga')).toBeNull();
  });
});

describe('keysFromUrls through the sandbox', () => {
  const spawn = (fixture: string, allowedNetHosts: string[] = []) =>
    spawnSandboxedSource(
      {
        id: 'url-keys-fixture',
        name: 'Fixture',
        lang: 'en',
        base_url: 'https://fixture.invalid',
        isNSFW: false,
      },
      {
        bundlePath: fileURLToPath(new URL(`./fixtures/sandbox/${fixture}`, import.meta.url)),
        allowedNetHosts,
        timeoutMs: 15000,
      },
    );

  it('runs the bundle’s keyFromUrl in the restricted child', async () => {
    const source = spawn('url-keys-source.mjs');
    try {
      expect(
        await source.keysFromUrls({
          manga: ['/title/abc', '/other/x'],
          chapters: ['/title/abc/ch-1?x=1', '/throw', '/long'],
        }),
      ).toEqual({ supported: true, manga: ['abc', null], chapters: ['ch-1', null, null] });
    } finally {
      source.dispose();
    }
  });

  it('refuses any fetch keyFromUrl starts, even to an allowed host', async () => {
    let requests = 0;
    const server = http.createServer((_req, res) => {
      requests += 1;
      res.end('ok');
    });
    const port = await new Promise<number>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)),
    );
    const source = spawn('url-keys-source.mjs', ['127.0.0.1']);
    try {
      const probe = `http://127.0.0.1:${port}/probe`;
      expect(await source.keysFromUrls({ manga: [], chapters: [probe] })).toEqual({
        supported: true,
        manga: [],
        chapters: ['probe'],
      });
      // Give a leaked request time to arrive before checking that none did.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(requests).toBe(0);
      await source.fetchManga(probe);
      expect(requests).toBe(1);
    } finally {
      source.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('reports bundles without keyFromUrl as unsupported', async () => {
    const source = spawn('catalogue-source.mjs');
    try {
      expect(await source.keysFromUrls({ manga: ['/a'], chapters: ['/b'] })).toEqual({
        supported: false,
        manga: [null],
        chapters: [null],
      });
    } finally {
      source.dispose();
    }
  });
});
