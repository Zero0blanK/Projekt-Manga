import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Chapters } from '@projekt-manga/types';
import { replaceBackupBodySchema } from '@projekt-manga/schemas';
import prisma from '../../src/configs/prisma.config.js';
import { replaceBackup } from '../../src/repositories/restore.repository.js';
import chapterService from '../../src/services/chapter.service.js';
// The payload under test is the one the web importer builds; its builder is pure TypeScript.
import { buildMihonImport } from '../../../web/src/lib/mihon-backup/payload.js';
import type { MihonBackup, MihonManga } from '../../../web/src/lib/mihon-backup/decode.js';

const SOURCE = 'madara-test';
const MIHON_ID = '6400665728063187402';

const title = (url: string, name: string, extra: Partial<MihonManga> = {}): MihonManga => ({
  source: MIHON_ID,
  url,
  title: name,
  author: 'Author',
  artist: null,
  description: 'About',
  genres: ['Action'],
  status: 1,
  thumbnailUrl: 'https://example.com/cover.jpg',
  dateAdded: 1_600_000_000_000,
  favorite: true,
  categories: [1],
  chapters: [],
  history: [],
  tracking: [],
  ...extra,
});

const backup: MihonBackup = {
  manga: [
    title('/manga/alpha/', 'Alpha', {
      chapters: [
        {
          url: '/manga/alpha/chapter-1/',
          name: 'Chapter 1',
          scanlator: null,
          read: true,
          bookmark: false,
          lastPageRead: 0,
          chapterNumber: 1,
          dateUpload: 1_700_000_000_000,
        },
        {
          url: '/manga/alpha/chapter-2/',
          name: 'Chapter 2',
          scanlator: 'Team',
          read: false,
          bookmark: true,
          lastPageRead: 5,
          chapterNumber: 2,
          dateUpload: 1_700_100_000_000,
        },
        {
          url: '/manga/alpha/chapter-3/',
          name: 'Chapter 3',
          scanlator: null,
          read: false,
          bookmark: false,
          lastPageRead: 0,
          chapterNumber: 3,
          dateUpload: 0,
        },
      ],
      history: [{ url: '/manga/alpha/chapter-2/', lastRead: 1_700_200_000_000 }],
      tracking: [{ syncId: 2, mediaId: '30013', trackingUrl: '', title: '' }],
    }),
    title('/series/lost', 'Lost', { source: '77' }),
    title('/manga/browsed/', 'Browsed', {
      favorite: false,
      chapters: [
        {
          url: '/manga/browsed/chapter-9/',
          name: 'Chapter 9',
          scanlator: null,
          read: true,
          bookmark: false,
          lastPageRead: 0,
          chapterNumber: 9,
          dateUpload: 0,
        },
      ],
      history: [{ url: '/manga/browsed/chapter-9/', lastRead: 1_700_300_000_000 }],
    }),
  ],
  categories: [{ name: 'Reading', order: 1 }],
  sources: [
    { id: MIHON_ID, name: 'Madara Test' },
    { id: '77', name: 'Gone' },
  ],
};

/** What the source's `keyFromUrl` would answer for these Madara paths. */
const segment = (url: string, index: number) => url.split('/').filter(Boolean)[index] ?? null;
const keys = new Map([
  [
    MIHON_ID,
    {
      supported: true,
      manga: new Map(backup.manga.map((m) => [m.url, segment(m.url, 1)])),
      chapters: new Map(
        backup.manga.flatMap((m) => m.chapters.map((c) => [c.url, segment(c.url, 2)] as const)),
      ),
    },
  ],
]);

const built = buildMihonImport(backup, {
  sources: new Map([
    [MIHON_ID, SOURCE],
    ['77', null],
  ]),
  keys,
  unmatched: 'import',
});

const restoreBody = (expectedUserId: string | null) =>
  replaceBackupBodySchema.parse({
    ...built.payload,
    jobId: randomUUID(),
    mode: 'merge',
    expectedUserId,
  });

const listed = (id: string, chapter_number: number): Chapters =>
  ({
    id,
    url: `https://madara.example/manga/alpha/${id}/`,
    name: `Chapter ${chapter_number}`,
    chapter_number,
    last_page_read: 0,
    release_date: '',
    pages: [],
  }) as Chapters;

describe('Mihon import payload (real SQLite)', () => {
  it('restores an anonymous library, keeps read state through the first chapter sync', async () => {
    const result = await replaceBackup(restoreBody(null));
    expect(result).toMatchObject({ restoredManga: 2 });

    const alpha = await prisma.manga.findFirstOrThrow({
      where: { source: SOURCE, slug: 'alpha' },
      include: { manga_detail: true },
    });
    expect(alpha).toMatchObject({ title: 'Alpha', in_library: true, author: 'Author' });
    expect(alpha.manga_detail).toMatchObject({ status: 'ONGOING', genres: 'Action' });

    const lost = await prisma.manga.findFirstOrThrow({ where: { source: 'mihon:Gone' } });
    expect(lost).toMatchObject({ slug: '/series/lost', in_library: true });
    expect(await prisma.manga.count({ where: { slug: 'browsed' } })).toBe(0);

    const chapters = await prisma.chapter.findMany({
      where: { source: SOURCE, manga_slug: 'alpha' },
      orderBy: { chapter_number: 'asc' },
    });
    expect(
      chapters.map((c) => [c.source_chapter_key, c.is_read, c.is_bookmark, c.last_page_read]),
    ).toEqual([
      ['chapter-1', true, false, 0],
      ['chapter-2', false, true, 5],
    ]);

    const history = await prisma.history.findMany({
      where: { user_id: null },
      include: { chapter: true },
      orderBy: { manga_slug: 'asc' },
    });
    expect(history.map((h) => [h.manga_slug, h.chapter?.source_chapter_key, h.manga_id])).toEqual([
      ['alpha', 'chapter-2', alpha.id],
      ['browsed', 'chapter-9', null],
    ]);

    // The first sync from the source adds the untouched chapter and keeps the imported state.
    await chapterService.syncChapters(
      'alpha',
      [listed('chapter-1', 1), listed('chapter-2', 2), listed('chapter-3', 3)],
      SOURCE,
    );
    const synced = await prisma.chapter.findMany({
      where: { source: SOURCE, manga_slug: 'alpha' },
      orderBy: { chapter_number: 'asc' },
    });
    expect(synced.map((c) => [c.source_chapter_key, c.is_read, c.last_page_read])).toEqual([
      ['chapter-1', true, 0],
      ['chapter-2', false, 5],
      ['chapter-3', false, 0],
    ]);
  });

  it("writes a signed-in account's overlay rows, and a second import adds nothing", async () => {
    const user = await prisma.user.create({
      data: { email: 'mihon-import@example.com', password_hash: 'x' },
    });
    await replaceBackup(restoreBody(user.id), user.id);
    await replaceBackup(restoreBody(user.id), user.id);

    expect(await prisma.manga.count({ where: { source: SOURCE } })).toBe(1);
    expect(await prisma.user_library.count({ where: { user_id: user.id, deleted_at: null } })).toBe(
      2,
    );
    const state = await prisma.user_chapter_state.findMany({
      where: { user_id: user.id },
      include: { chapter: true },
      orderBy: { chapter: { chapter_number: 'asc' } },
    });
    expect(state.map((s) => [s.chapter.source_chapter_key, s.is_read, s.last_page_read])).toEqual([
      ['chapter-1', true, 0],
      ['chapter-2', false, 5],
      // From the history of a title that was only browsed, never added to the library.
      ['chapter-9', true, 0],
    ]);
    expect(await prisma.manga.count({ where: { slug: 'browsed' } })).toBe(0);
    expect(await prisma.history.count({ where: { user_id: user.id } })).toBe(2);
    // Anonymous use is untouched by an account's import.
    expect(await prisma.history.count({ where: { user_id: null } })).toBe(0);
  });
});
