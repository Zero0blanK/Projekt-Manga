import { describe, expect, it, vi } from 'vitest';
import type { Source } from '@projekt-manga/types';
import { sourceCapabilities, sourceCataloguePage } from '../sandbox/runner.js';
import { spawnSandboxedSource } from '../dist/sandbox/index.js';
import { fileURLToPath } from 'node:url';

const rows = ['a', 'a', 'b', 'c'].map((id) => ({
  id,
  slug: id,
  title: id,
  source: 'fixture',
  thumbnail_url: '',
}));
function legacySource(): Source {
  const fetchManga = vi.fn(async (_value, pagination) =>
    rows.slice(pagination.offset, pagination.offset + pagination.limit),
  );
  return { id: 'fixture', fetchManga, searchManga: fetchManga } as unknown as Source;
}

describe('source catalogue compatibility', () => {
  it('uses lookahead and advances across duplicate raw rows without dropping the next card', async () => {
    const source = legacySource();
    const first = await sourceCataloguePage(source, false, 'latest', { limit: 2 });
    expect(first).toEqual({ items: rows.slice(0, 2), hasMore: true, nextCursor: 'legacy:2' });
    const last = await sourceCataloguePage(source, true, 'title', {
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(last).toEqual({ items: rows.slice(2), hasMore: false });
    expect(source.searchManga).toHaveBeenLastCalledWith(
      'title',
      { limit: 3, offset: 2 },
      undefined,
    );
  });

  it.each([
    'bad',
    'legacy:-1',
    'legacy:1.2',
    'legacy:01',
    'legacy:9007199254740992',
    'x'.repeat(1025),
  ])('rejects invalid legacy cursor %s', async (cursor) => {
    const source = legacySource();
    await expect(sourceCataloguePage(source, false, undefined, { cursor })).rejects.toMatchObject({
      code: 'PARSE_ERROR',
    });
    expect(source.fetchManga).not.toHaveBeenCalled();
  });

  it.each([0, 101, 1.5, Infinity])('rejects invalid page size %s', async (limit) => {
    await expect(
      sourceCataloguePage(legacySource(), false, undefined, { limit }),
    ).rejects.toMatchObject({ code: 'PARSE_ERROR' });
  });

  it('delegates opaque native cursors and preserves classified errors', async () => {
    const source = legacySource();
    source.fetchMangaPage = vi.fn(async () => ({ items: [rows[0]!], hasMore: false }));
    const filters = { status: 'ongoing' };
    await sourceCataloguePage(
      source,
      false,
      'popular',
      { cursor: 'native:next', limit: 10 },
      filters,
    );
    expect(source.fetchMangaPage).toHaveBeenCalledWith(
      'popular',
      { cursor: 'native:next', limit: 10 },
      filters,
    );
    expect(source.fetchManga).not.toHaveBeenCalled();
    const blocked = Object.assign(new Error('Blocked'), { code: 'BLOCKED' });
    vi.mocked(source.fetchMangaPage).mockRejectedValueOnce(blocked);
    await expect(sourceCataloguePage(source, false)).rejects.toBe(blocked);
  });

  it('declares legacy capabilities without calling filters or network', async () => {
    expect(await sourceCapabilities(legacySource())).toEqual({
      latest: true,
      search: true,
      filters: true,
      languageFilter: false,
      urlSearch: false,
      nativePagination: false,
    });
  });

  it('requires implementation methods for native pagination and URL search', async () => {
    const source = legacySource();
    source.getCapabilities = async () => ({
      latest: false,
      search: true,
      filters: false,
      languageFilter: false,
      urlSearch: true,
      nativePagination: true,
    });
    expect(await sourceCapabilities(source)).toMatchObject({
      latest: false,
      urlSearch: false,
      nativePagination: false,
    });
    source.fetchMangaPage = source.searchMangaPage = async () => ({ items: [], hasMore: false });
    source.resolveMangaUrl = async () => null;
    expect(await sourceCapabilities(source)).toMatchObject({
      urlSearch: true,
      nativePagination: true,
    });
  });

  it('carries optional methods and legacy fallback through the real restricted IPC runner', async () => {
    const source = spawnSandboxedSource(
      {
        id: 'catalogue-fixture',
        name: 'Fixture',
        lang: 'en',
        base_url: 'https://fixture.invalid',
        isNSFW: false,
      },
      {
        bundlePath: fileURLToPath(
          new URL('./fixtures/sandbox/catalogue-source.mjs', import.meta.url),
        ),
        allowedNetHosts: [],
      },
    );
    try {
      expect(await source.getCapabilities!()).toMatchObject({
        nativePagination: false,
        urlSearch: false,
      });
      expect((await source.fetchMangaPage!()).items.map((item) => item.id)).toEqual([
        'a',
        'a',
        'b',
        'c',
      ]);
      const first = await source.fetchMangaPage!('latest', { limit: 2 });
      expect(first.nextCursor).toBe('legacy:2');
      expect(
        (await source.searchMangaPage!('title', { limit: 2, cursor: first.nextCursor })).items.map(
          (item) => item.id,
        ),
      ).toEqual(['b', 'c']);
      await expect(source.resolveMangaUrl!('https://fixture.invalid/')).rejects.toThrow(
        'does not support URL search',
      );
      await expect(source.fetchMangaPage!('latest', { cursor: 'invalid' })).rejects.toMatchObject({
        code: 'PARSE_ERROR',
        reason: 'INVALID_CURSOR',
      });
    } finally {
      source.dispose();
    }
  });

  it('normalizes omitted optional arguments through native IPC', async () => {
    const source = spawnSandboxedSource(
      {
        id: 'native-catalogue-fixture',
        name: 'Fixture',
        lang: 'en',
        base_url: 'https://fixture.invalid',
        isNSFW: false,
      },
      {
        bundlePath: fileURLToPath(
          new URL('./fixtures/sandbox/native-catalogue-source.mjs', import.meta.url),
        ),
        allowedNetHosts: [],
      },
    );
    try {
      expect((await source.fetchMangaPage!()).items[0]?.title).toBe('latest:20:all');
      expect((await source.fetchMangaPage!('popular', { limit: 2 })).items[0]?.title).toBe(
        'popular:2:all',
      );
      expect((await source.searchMangaPage!()).items[0]?.title).toBe('search:20:all');
      expect((await source.searchMangaPage!('title', { limit: 2 })).items[0]?.title).toBe(
        'title:2:all',
      );
    } finally {
      source.dispose();
    }
  });
});
