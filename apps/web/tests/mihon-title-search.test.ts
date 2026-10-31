import { describe, expect, it, vi } from 'vitest';
import type { Mangas } from '@projekt-manga/types';
import {
  bestTitleMatch,
  buildMihonImport,
  findTitlesInSources,
  type MihonBackup,
  type MihonManga,
} from '@/lib/mihon-backup';

const title = (source: string, name: string, extra: Partial<MihonManga> = {}): MihonManga => ({
  source,
  url: `/series/${name.toLowerCase().replace(/\W+/g, '-')}`,
  title: name,
  author: null,
  artist: null,
  description: null,
  genres: [],
  status: 1,
  thumbnailUrl: 'https://old.example/cover.jpg',
  dateAdded: 0,
  favorite: true,
  categories: [],
  chapters: [],
  history: [],
  tracking: [],
  ...extra,
});

const result = (source: string, name: string, slug = name.toLowerCase()): Mangas => ({
  id: slug,
  slug,
  title: name,
  source,
  thumbnail_url: `https://${source}.example/${slug}.jpg`,
});

const backup: MihonBackup = {
  manga: [
    title('1', 'Solo Leveling', {
      chapters: [
        {
          url: '/ch/1',
          name: 'Chapter 1',
          scanlator: null,
          read: true,
          bookmark: false,
          lastPageRead: 0,
          chapterNumber: 1,
          dateUpload: 0,
        },
      ],
    }),
    title('1', 'Omniscient Reader'),
    title('1', 'Nowhere Title'),
    title('2', 'Tower of God'),
    title('1', 'Browsed Only', { favorite: false }),
  ],
  categories: [],
  sources: [
    { id: '1', name: 'Dead Scans' },
    { id: '2', name: 'Old Site' },
  ],
};

describe('bestTitleMatch', () => {
  it('prefers an exact match and ignores unrelated titles', () => {
    const items = [
      result('a', 'Solo Leveling: Ragnarok'),
      result('a', 'Solo Leveling'),
      result('a', 'Something Else'),
    ];
    expect(bestTitleMatch('Solo Leveling', items)?.item.title).toBe('Solo Leveling');
    expect(bestTitleMatch('Tower of God', items)).toBeNull();
  });
});

describe('findTitlesInSources', () => {
  const catalog: Record<string, Mangas[]> = {
    a: [result('a', 'Solo Leveling')],
    b: [result('b', 'Solo Leveling'), result('b', 'Omniscient Reader')],
    c: [result('c', 'Tower of God')],
  };
  const search = vi.fn(async (sourceId: string, query: string) => {
    if (sourceId === 'broken') throw new Error('down');
    return (catalog[sourceId] ?? []).filter((item) => item.title === query);
  });

  it('tries each listed source in order and stops at the first match', async () => {
    search.mockClear();
    const progress: number[] = [];
    const out = await findTitlesInSources(
      backup,
      new Map([
        ['1', null],
        ['2', null],
      ]),
      new Map([
        ['1', ['broken', 'a', 'b']],
        ['2', ['c']],
      ]),
      search,
      { onProgress: ({ done }) => progress.push(done) },
    );
    expect(out.found.get(0)).toMatchObject({ sourceId: 'a', slug: 'solo leveling', score: 1 });
    expect(out.found.get(1)?.sourceId).toBe('b');
    expect(out.found.get(3)?.sourceId).toBe('c');
    expect(out.missing).toEqual([2]);
    expect(out.failedSources).toEqual(['broken']);
    // Titles only in history are not searched; a found title skips the later sources.
    expect(search).not.toHaveBeenCalledWith('a', 'Browsed Only', undefined);
    expect(search).not.toHaveBeenCalledWith('b', 'Solo Leveling', undefined);
    expect(progress.at(-1)).toBe(4);
  });

  it('leaves sources with a direct match, or no order, alone', async () => {
    search.mockClear();
    const out = await findTitlesInSources(
      backup,
      new Map([
        ['1', 'installed'],
        ['2', null],
      ]),
      new Map([['1', ['a']]]),
      search,
    );
    expect(out.found.size).toBe(0);
    expect(search).not.toHaveBeenCalled();
  });

  it('stops when aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      findTitlesInSources(backup, new Map(), new Map([['1', ['a']]]), search, {
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });
});

describe('buildMihonImport with titles found by name', () => {
  it('imports them under the source they were found in, with state by chapter number', () => {
    const built = buildMihonImport(backup, {
      sources: new Map([
        ['1', null],
        ['2', null],
      ]),
      keys: new Map(),
      unmatched: 'skip',
      found: new Map([
        [
          0,
          {
            sourceId: 'a',
            slug: 'solo-leveling',
            title: 'Solo Leveling',
            thumbnailUrl: 'https://a.example/s.jpg',
            score: 1,
          },
        ],
      ]),
    });
    expect(built.payload.manga).toHaveLength(1);
    expect(built.payload.manga[0]).toMatchObject({
      source: 'a',
      slug: 'solo-leveling',
      thumbnail_url: 'https://a.example/s.jpg',
      chapters: [],
    });
    expect(built.extras.chapterNumbers).toEqual([
      { source: 'a', slug: 'solo-leveling', read: [1], lastPage: [] },
    ]);
    expect(built.stats).toMatchObject({ foundBySearch: 1, unmatchedSkipped: 3 });
  });
});
