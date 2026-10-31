import { describe, it, expect } from 'vitest';
import type { Chapters } from '@projekt-manga/types';
import prisma from '../../src/configs/prisma.config.js';
import chapterService from '../../src/services/chapter.service.js';
import chapterRepository from '../../src/repositories/chapter.repository.js';
import syncService from '../../src/services/sync.service.js';
import historyRepository from '../../src/repositories/history.repository.js';
import { addHistoryBodySchema, syncPushBodySchema } from '@projekt-manga/schemas';

// Real foreign keys, cascades and the title-scoped unique key, which the mocked unit tests
// cannot show.

const SOURCE = 'source-a';
const SLUG = 'relinked-title';

async function seedTitle(slug = SLUG) {
  return prisma.manga.create({
    data: { slug, title: 'Relinked', author: 'A', source: SOURCE, thumbnail_url: '' },
  });
}

const key = (source_chapter_key: string, manga_slug = SLUG) => ({
  source: SOURCE,
  manga_slug,
  source_chapter_key,
});

function listed(id: string, chapter_number: number, extra: Partial<Chapters> = {}): Chapters {
  return {
    id,
    url: `https://source-a.example/${id}`,
    name: `Chapter ${chapter_number}`,
    chapter_number,
    last_page_read: 0,
    release_date: '',
    pages: [],
    ...extra,
  } as Chapters;
}

describe('chapter sync on a library update (real DB)', () => {
  it('relinks a chapter in place: same row, new key, everything still attached', async () => {
    const manga = await seedTitle();
    const user = await prisma.user.create({
      data: { email: 'relink@example.com', password_hash: 'x' },
    });
    const fetchedAt = new Date('2026-01-01T00:00:00.000Z');
    const row = await prisma.chapter.create({
      data: {
        ...key('old-5'),
        manga_id: manga.id,
        url: 'https://source-a.example/old-5',
        name: 'Chapter 5',
        chapter_number: 5,
        is_read: true,
        last_page_read: 12,
        page_count: 20,
        fetched_at: fetchedAt,
      },
    });
    await prisma.user_chapter_state.create({
      data: { user_id: user.id, chapter_id: row.id, is_read: true, last_page_read: 12 },
    });
    const history = await prisma.history.create({
      data: { source: SOURCE, manga_id: manga.id, manga_slug: SLUG, chapter_id: row.id },
    });
    const download = await prisma.download.create({
      data: {
        manga_id: manga.id,
        chapter_id: row.id,
        source_id: SOURCE,
        file_path: 'Relinked/Chapter_5',
        status: 'COMPLETED',
      },
    });

    const result = await chapterService.syncChapters(
      SLUG,
      [listed('new-5', 5), listed('new-6', 6)],
      SOURCE,
    );

    expect(result).toMatchObject({ added: 1, relinked: 1, removed: 0, suspicious: false });
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      source_chapter_key: 'new-5',
      url: 'https://source-a.example/new-5',
      is_read: true,
      last_page_read: 12,
      page_count: 20,
      fetched_at: fetchedAt,
    });
    expect(
      await prisma.user_chapter_state.findUniqueOrThrow({
        where: { user_id_chapter_id: { user_id: user.id, chapter_id: row.id } },
      }),
    ).toMatchObject({ is_read: true, last_page_read: 12 });
    expect((await prisma.history.findUniqueOrThrow({ where: { id: history.id } })).chapter_id).toBe(
      row.id,
    );
    expect(
      (await prisma.download.findUniqueOrThrow({ where: { id: download.id } })).chapter_id,
    ).toBe(row.id);
    const added = await prisma.chapter.findUniqueOrThrow({
      where: { source_manga_slug_source_chapter_key: key('new-6') },
    });
    expect(added).toMatchObject({ manga_id: manga.id, is_read: false });
    expect(added.id).not.toBe('new-6');
  });

  it('folds a placeholder already holding the new key into the relinked row', async () => {
    const manga = await seedTitle();
    const user = await prisma.user.create({
      data: { email: 'merge@example.com', password_hash: 'x' },
    });
    const row = await prisma.chapter.create({
      data: {
        ...key('old-1'),
        manga_id: manga.id,
        url: '/old-1',
        chapter_number: 1,
        is_bookmark: true,
      },
    });
    // What a preview read of the relinked chapter left behind before the title was stored
    // (or after it was removed and re-added): a manga-less row under the new key.
    const placeholder = await prisma.chapter.create({
      data: { ...key('new-1'), manga_id: null, url: '', chapter_number: 0 },
    });
    await prisma.user_chapter_state.create({
      data: { user_id: user.id, chapter_id: row.id, is_bookmark: true, last_page_read: 7 },
    });
    await prisma.user_chapter_state.create({
      data: { user_id: user.id, chapter_id: placeholder.id, is_read: true, last_page_read: 2 },
    });
    const history = await prisma.history.create({
      data: { source: SOURCE, manga_slug: SLUG, chapter_id: placeholder.id, user_id: user.id },
    });

    const result = await chapterService.syncChapters(SLUG, [listed('new-1', 1)], SOURCE);

    expect(result).toMatchObject({ added: 0, relinked: 1 });
    expect(await prisma.chapter.findUnique({ where: { id: placeholder.id } })).toBeNull();
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      source_chapter_key: 'new-1',
      chapter_number: 1,
      is_bookmark: true,
    });
    const states = await prisma.user_chapter_state.findMany({ where: { user_id: user.id } });
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({
      chapter_id: row.id,
      is_read: true,
      is_bookmark: true,
      last_page_read: 7,
    });
    expect((await prisma.history.findUniqueOrThrow({ where: { id: history.id } })).chapter_id).toBe(
      row.id,
    );
  });

  it('folding a placeholder leaves one history row per reader and one download', async () => {
    const manga = await seedTitle();
    const user = await prisma.user.create({
      data: { email: 'merge-dupes@example.com', password_hash: 'x' },
    });
    const row = await prisma.chapter.create({
      data: { ...key('old-2'), manga_id: manga.id, url: '/old-2', chapter_number: 2 },
    });
    const placeholder = await prisma.chapter.create({
      data: { ...key('new-2'), manga_id: null, url: '', chapter_number: 0 },
    });
    const history = (chapter_id: string, minutes: number, lastRead: string) =>
      prisma.history.create({
        data: {
          source: SOURCE,
          manga_slug: SLUG,
          chapter_id,
          user_id: user.id,
          time_read: minutes * 60_000,
          pages_read: minutes,
          last_read: new Date(lastRead),
        },
      });
    const kept = await history(row.id, 5, '2026-01-01T00:00:00Z');
    const folded = await history(placeholder.id, 3, '2026-02-01T00:00:00Z');
    // The anonymous library's row is a different reader's: it moves over untouched.
    const anonymous = await prisma.history.create({
      data: { source: SOURCE, manga_slug: SLUG, chapter_id: placeholder.id },
    });
    const download = (chapter_id: string, status: string) =>
      prisma.download.create({
        data: {
          manga_id: manga.id,
          chapter_id,
          source_id: SOURCE,
          file_path: `/d/${chapter_id}`,
          status,
        },
      });
    await download(row.id, 'FAILED');
    const completed = await download(placeholder.id, 'COMPLETED');

    await chapterService.syncChapters(SLUG, [listed('new-2', 2)], SOURCE);

    const live = await prisma.history.findMany({ where: { chapter_id: row.id, deleted_at: null } });
    expect(live.map((entry) => entry.id).sort()).toEqual([anonymous.id, kept.id].sort());
    expect(await prisma.history.findUniqueOrThrow({ where: { id: kept.id } })).toMatchObject({
      time_read: 8 * 60_000,
      pages_read: 5,
      last_read: new Date('2026-02-01T00:00:00Z'),
    });
    // The folded row stays as a tombstone, so other devices drop their copy.
    const tombstone = await prisma.history.findUniqueOrThrow({ where: { id: folded.id } });
    expect(tombstone.deleted_at).not.toBeNull();
    expect(tombstone.chapter_id).toBe(row.id);
    const downloads = await prisma.download.findMany({ where: { chapter_id: row.id } });
    expect(downloads.map((entry) => entry.id)).toEqual([completed.id]);
  });

  it('relinks a long series across several batches, keeping every row', async () => {
    const manga = await seedTitle('long-series');
    const count = 250;
    await prisma.chapter.createMany({
      data: Array.from({ length: count }, (_, i) => ({
        ...key(`old-${i + 1}`, 'long-series'),
        id: `long-row-${i + 1}`,
        manga_id: manga.id,
        url: `/old-${i + 1}`,
        chapter_number: i + 1,
      })),
    });

    const result = await chapterService.syncChapters(
      'long-series',
      Array.from({ length: count }, (_, i) => listed(`new-${i + 1}`, i + 1)),
      SOURCE,
    );

    expect(result).toMatchObject({ added: 0, relinked: count });
    const rows = await prisma.chapter.findMany({
      where: { manga_id: manga.id },
      orderBy: { chapter_number: 'asc' },
    });
    expect(rows).toHaveLength(count);
    expect(rows.every((row, i) => row.id === `long-row-${i + 1}`)).toBe(true);
    expect(rows.every((row, i) => row.source_chapter_key === `new-${i + 1}`)).toBe(true);
  });

  it('removes untouched stale chapters and keeps ones with reading state or history', async () => {
    const manga = await seedTitle();
    for (const [chapterKey, chapter_number] of [
      ['c1', 1],
      ['c2', 2],
      ['c3', 3],
      ['c4', 4],
    ] as const) {
      await prisma.chapter.create({
        data: {
          ...key(chapterKey),
          manga_id: manga.id,
          url: `/${chapterKey}`,
          name: `Chapter ${chapter_number}`,
          chapter_number,
        },
      });
    }
    await prisma.chapter.create({
      data: {
        ...key('gone-read'),
        manga_id: manga.id,
        url: '/r',
        chapter_number: 3.5,
        is_read: true,
      },
    });
    const withHistory = await prisma.chapter.create({
      data: { ...key('gone-history'), manga_id: manga.id, url: '/h', chapter_number: 3.6 },
    });
    await prisma.history.create({
      data: { source: SOURCE, manga_id: manga.id, manga_slug: SLUG, chapter_id: withHistory.id },
    });
    await prisma.chapter.create({
      data: { ...key('gone-untouched'), manga_id: manga.id, url: '/u', chapter_number: 3.7 },
    });

    const result = await chapterService.syncChapters(
      SLUG,
      [listed('c1', 1), listed('c2', 2), listed('c3', 3), listed('c4', 4)],
      SOURCE,
    );

    expect(result).toMatchObject({ added: 0, relinked: 0, removed: 1, suspicious: false });
    const keys = (await prisma.chapter.findMany({ where: { manga_id: manga.id } }))
      .map((c) => c.source_chapter_key)
      .sort();
    expect(keys).toEqual(['c1', 'c2', 'c3', 'c4', 'gone-history', 'gone-read']);
  });

  it('lets two titles carry the same source key without touching each other', async () => {
    const manga = await seedTitle();
    const other = await seedTitle('other-title');
    const otherRow = await prisma.chapter.create({
      data: {
        ...key('chapter-1', 'other-title'),
        manga_id: other.id,
        url: '/other',
        chapter_number: 1,
        is_read: true,
      },
    });

    const result = await chapterService.syncChapters(SLUG, [listed('chapter-1', 1)], SOURCE);

    expect(result).toMatchObject({ added: 1, relinked: 0 });
    const mine = await prisma.chapter.findUniqueOrThrow({
      where: { source_manga_slug_source_chapter_key: key('chapter-1') },
    });
    expect(mine).toMatchObject({ manga_id: manga.id, is_read: false });
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: otherRow.id } })).toMatchObject({
      manga_id: other.id,
      is_read: true,
    });
  });
});

describe('chapter keys on the wire (real DB)', () => {
  it('an older client naming chapters by row id still pushes and adds history', async () => {
    const manga = await seedTitle('legacy-title');
    const user = await prisma.user.create({
      data: { email: 'legacy-client@example.com', password_hash: 'x' },
    });
    const chapter = await prisma.chapter.create({
      data: {
        ...key('legacy-key', 'legacy-title'),
        manga_id: manga.id,
        url: '/l',
        chapter_number: 4,
      },
    });
    // Parsed as the route parses it, so the schema accepts the old shape.
    const body = syncPushBodySchema.parse({
      chapter_state: [
        {
          chapter_id: chapter.id,
          is_read: true,
          is_bookmark: false,
          last_page_read: 6,
          updated_at: '2026-03-01T00:00:00.000Z',
        },
        {
          chapter_id: 'no-such-row',
          is_read: true,
          is_bookmark: false,
          last_page_read: 0,
          updated_at: '2026-03-01T00:00:00.000Z',
        },
      ],
      history: [
        {
          id: 'hist-legacy',
          source: SOURCE,
          manga_id: manga.id,
          manga_slug: 'legacy-title',
          title: 'Legacy',
          thumbnail_url: null,
          chapter_id: chapter.id,
          read_at: '2026-03-01T00:00:00.000Z',
          last_read: '2026-03-01T00:00:00.000Z',
          pages_read: 6,
          time_read: 0,
          deleted_at: null,
        },
      ],
    });
    const pushed = await syncService.push(user.id, body);
    // The unknown row fails on its own; the rest of the batch applies.
    expect(pushed.chapter_state).toEqual({ applied: 1, failed: ['no-such-row'] });
    expect(pushed.history).toEqual({ applied: 1, failed: [] });
    expect(
      await prisma.user_chapter_state.findUniqueOrThrow({
        where: { user_id_chapter_id: { user_id: user.id, chapter_id: chapter.id } },
      }),
    ).toMatchObject({ is_read: true, last_page_read: 6 });
    expect(
      (await prisma.history.findUniqueOrThrow({ where: { id: 'hist-legacy' } })).chapter_id,
    ).toBe(chapter.id);

    // The add-history route: the named chapter, not the title's newest one.
    await prisma.chapter.create({
      data: {
        ...key('legacy-newer', 'legacy-title'),
        manga_id: manga.id,
        url: '/n',
        chapter_number: 9,
      },
    });
    const added = await historyRepository.addHistory(
      addHistoryBodySchema.parse({
        source: SOURCE,
        manga_slug: 'legacy-title',
        chapter_id: chapter.id,
        pages_read: 2,
      }),
      user.id,
    );
    expect(added.chapter_id).toBe(chapter.id);
  });

  it('a sync push for a chapter never stored stands up a placeholder, and pull names it by key', async () => {
    const user = await prisma.user.create({
      data: { email: 'sync-key@example.com', password_hash: 'x' },
    });

    const pushed = await syncService.push(user.id, {
      chapter_state: [
        {
          ...key('read-offline', 'not-stored-title'),
          is_read: true,
          is_bookmark: false,
          last_page_read: 0,
          updated_at: '2026-02-01T00:00:00.000Z',
        },
      ],
      history: [
        {
          id: 'hist-offline',
          source: SOURCE,
          manga_id: null,
          manga_slug: 'not-stored-title',
          title: 'Not stored',
          thumbnail_url: null,
          source_chapter_key: 'read-offline',
          read_at: '2026-02-01T00:00:00.000Z',
          last_read: '2026-02-01T00:00:00.000Z',
          pages_read: 3,
          time_read: 0,
          deleted_at: null,
        },
      ],
    });

    expect(pushed.chapter_state).toEqual({ applied: 1, failed: [] });
    expect(pushed.history).toEqual({ applied: 1, failed: [] });
    const placeholder = await prisma.chapter.findUniqueOrThrow({
      where: { source_manga_slug_source_chapter_key: key('read-offline', 'not-stored-title') },
    });
    expect(placeholder.manga_id).toBeNull();
    expect(
      (await prisma.history.findUniqueOrThrow({ where: { id: 'hist-offline' } })).chapter_id,
    ).toBe(placeholder.id);

    const pulled = await syncService.pull(user.id, undefined);
    expect(pulled.chapter_state).toEqual([
      expect.objectContaining({ ...key('read-offline', 'not-stored-title'), is_read: true }),
    ]);
    expect(pulled.history).toEqual([
      expect.objectContaining({ id: 'hist-offline', source_chapter_key: 'read-offline' }),
    ]);

    // Adding the title adopts the placeholder by key instead of duplicating it.
    await prisma.manga.create({
      data: {
        slug: 'not-stored-title',
        title: 'Not stored',
        author: 'A',
        source: SOURCE,
        thumbnail_url: '',
      },
    });
    const adopted = await chapterRepository.resolveChapter(
      key('read-offline', 'not-stored-title'),
      { chapter_number: 4 },
    );
    expect(adopted.id).toBe(placeholder.id);
    expect(adopted.manga_id).not.toBeNull();
    expect(adopted.chapter_number).toBe(4);
  });
});
