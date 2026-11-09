import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, utimes, writeFile, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import prisma from '../../src/configs/prisma.config.js';

/**
 * Downloads found on disk with no record of them — the state after app data is lost — are
 * scanned, identified and added back, against a real database.
 *
 * Sources are faked: one installed ("fake-src", which knows one title), one not
 * ("gone-src"). Nothing here reaches the network.
 */

const sourceMocks = vi.hoisted(() => ({
  installed: new Set(['fake-src']),
}));

vi.mock('../../src/services/sourceResolver.service.js', () => ({
  resolveSource: vi.fn(async (id: string) => (sourceMocks.installed.has(id) ? { id } : undefined)),
}));

vi.mock('../../src/services/source.service.js', () => ({
  default: {
    getSources: vi.fn(async () => [{ id: 'fake-src', name: 'Fake Source' }]),
    searchManga: vi.fn(async () => [
      {
        id: 'native-1',
        slug: 'old-title',
        title: 'Old: Title',
        source: 'fake-src',
        thumbnail_url: '',
      },
      {
        id: 'native-2',
        slug: 'other',
        title: 'Something else',
        source: 'fake-src',
        thumbnail_url: '',
      },
    ]),
    getMangaDetails: vi.fn(async (_source: string, id: string) => ({
      id,
      slug: id === 'native-1' ? 'old-title' : 'other',
      title: id === 'native-1' ? 'Old: Title' : 'Something else',
      source: 'fake-src',
      thumbnail_url: 'https://example.invalid/cover.jpg',
      description: 'From the source',
      genres: ['Drama'],
      status: 'Ongoing',
      author: ['Someone'],
      chapters: [
        {
          id: 'chapter-key-that-is-quite-long-0001',
          name: 'The start',
          url: '',
          chapter_number: 1,
          last_page_read: 0,
          release_date: '',
          pages: [],
        },
        {
          id: 'chapter-key-that-is-quite-long-0002',
          name: 'The middle',
          url: '',
          chapter_number: 2,
          last_page_read: 0,
          release_date: '',
          pages: [],
        },
      ],
    })),
  },
}));

const { scanForDownloadsToRestore, restoreDownloads, clearRestoreLookupCache } =
  await import('../../src/services/downloadRestore.service.js');
const downloadService = (await import('../../src/services/download.service.js')).default;
const { writeChapterIdentity, writeTitleIdentity, folderKeySuffix } =
  await import('../../src/utils/downloadIdentity.js');

let root = '';
const previousRoot = downloadService.getDownloadDir();
const DAY_AGO = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

async function chapterFolder(dir: string, pages: number, missing: number[] = []) {
  await mkdir(dir, { recursive: true });
  for (let page = 1; page <= pages; page++) {
    if (missing.includes(page)) continue;
    await writeFile(path.join(dir, `page_${String(page).padStart(3, '0')}.jpg`), 'jpg');
  }
}

/** A title downloaded since info files were written: chapters 1 and 2 whole, 3 cut short. */
async function newStyleTitle() {
  const titleDir = path.join(root, 'New Title [gone-src]');
  await mkdir(titleDir, { recursive: true });
  await writeTitleIdentity(titleDir, {
    source: 'gone-src',
    slug: 'new-title',
    title: 'New Title',
    author: 'Author',
    thumbnailUrl: null,
  });
  for (const [number, pages, saved] of [
    [1, 3, 3],
    [2, 2, 2],
    [3, 5, 3],
  ] as const) {
    const dir = path.join(titleDir, `Chapter_${number} - key-${number}`);
    await chapterFolder(dir, saved);
    await writeChapterIdentity(dir, {
      source: 'gone-src',
      mangaSlug: 'new-title',
      mangaTitle: 'New Title',
      chapterKey: `key-${number}`,
      chapterNumber: number,
      chapterName: `Part ${number}`,
      scanlator: null,
      pageCount: pages,
    });
    await utimes(dir, DAY_AGO, DAY_AGO);
  }
  return titleDir;
}

beforeEach(async () => {
  clearRestoreLookupCache();
  root = await mkdtemp(path.join(os.tmpdir(), 'pm-restore-'));
  downloadService.setDownloadDir(root);
});

// Each test's folder goes, so the next one finds only its own downloads.
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = '';
});

afterAll(() => {
  downloadService.setDownloadDir(previousRoot);
});

describe('restoring downloads found on disk', () => {
  it('identifies each title folder and says what can come back', async () => {
    await newStyleTitle();
    // Older downloads: only folder names. One source is installed, one isn't.
    const oldKey = folderKeySuffix('chapter-key-that-is-quite-long-0002');
    await chapterFolder(path.join(root, 'Old_ Title [fake-src]', `Chapter_2 - ${oldKey}`), 4);
    await chapterFolder(path.join(root, 'Lost Title [gone-src]', 'Chapter_7 - abcdef'), 2);
    // A folder that is not a download at all.
    await mkdir(path.join(root, 'Holiday photos', 'Beach'), { recursive: true });

    const scan = await scanForDownloadsToRestore();

    const byTitle = new Map(scan.titles.map((title) => [title.title, title]));
    expect(byTitle.get('New Title')).toMatchObject({
      status: 'ready',
      source: 'gone-src',
      chapters: { ready: 2, incomplete: 1, alreadyInApp: 0, unmatched: 0 },
    });
    expect(byTitle.get('Old: Title')).toMatchObject({
      status: 'ready',
      sourceName: 'Fake Source',
      chapters: { ready: 1, incomplete: 0, alreadyInApp: 0, unmatched: 0 },
    });
    expect(byTitle.get('Lost Title')).toMatchObject({
      status: 'needs-source',
      chapters: { ready: 0, unmatched: 1 },
    });
    expect(byTitle.has('Holiday photos')).toBe(false);
    expect(scan.restorableChapters).toBe(3);
  });

  it('adds the chosen titles back as downloads, outside the library, and only once', async () => {
    await newStyleTitle();
    const oldKey = folderKeySuffix('chapter-key-that-is-quite-long-0002');
    const oldChapter = path.join(root, 'Old_ Title [fake-src]', `Chapter_2 - ${oldKey}`);
    await chapterFolder(oldChapter, 4);
    const scan = await scanForDownloadsToRestore();
    const ids = scan.titles.filter((title) => title.status === 'ready').map((title) => title.id);

    const result = await restoreDownloads(ids);

    expect(result).toMatchObject({ restored: 3, relinked: 0 });
    expect(result.titles.map((title) => title.title).sort()).toEqual(['New Title', 'Old: Title']);
    const manga = await prisma.manga.findMany({ orderBy: { slug: 'asc' } });
    expect(manga.map((row) => [row.source, row.slug, row.in_library])).toEqual([
      ['gone-src', 'new-title', false],
      ['fake-src', 'old-title', false],
    ]);
    // The source's listing came with the older title, chapter names included.
    const oldTitleChapters = await prisma.chapter.findMany({
      where: { manga_slug: 'old-title' },
      orderBy: { chapter_number: 'asc' },
    });
    expect(oldTitleChapters.map((chapter) => chapter.name)).toEqual(['The start', 'The middle']);

    // The Downloads list shows them as finished, pointing at the folders found.
    const downloads = await downloadService.getAllDownloads();
    expect(downloads).toHaveLength(3);
    expect(downloads.every((download) => download.status === 'COMPLETED')).toBe(true);
    const old = downloads.find((download) => download.mangaSlug === 'old-title');
    expect(old?.downloaded_path).toBe(oldChapter);
    expect(old?.chapterNumber).toBe(2);

    // Nothing is left to restore, and restoring again adds nothing.
    const again = await scanForDownloadsToRestore();
    expect(again.restorableChapters).toBe(0);
    expect(await restoreDownloads(ids)).toMatchObject({ restored: 0, relinked: 0 });
    expect(await prisma.download.count()).toBe(3);
  });

  it('points a download whose folder moved at where it is now', async () => {
    const titleDir = await newStyleTitle();
    const first = await scanForDownloadsToRestore();
    await restoreDownloads(first.titles.map((title) => title.id));

    // The whole title moves to another drive or folder.
    const elsewhere = await mkdtemp(path.join(os.tmpdir(), 'pm-restore-moved-'));
    try {
      const movedTitle = path.join(elsewhere, path.basename(titleDir));
      await rename(titleDir, movedTitle);

      const scan = await scanForDownloadsToRestore(elsewhere);
      expect(scan.titles[0]).toMatchObject({
        title: 'New Title',
        chapters: { ready: 2, incomplete: 1 },
      });
      const result = await restoreDownloads([scan.titles[0].id], elsewhere);

      expect(result).toMatchObject({ restored: 0, relinked: 2 });
      expect(await prisma.download.count()).toBe(2);
      const downloads = await downloadService.getAllDownloads();
      expect(downloads.map((download) => download.downloaded_path).sort()).toEqual([
        path.join(movedTitle, 'Chapter_1 - key-1'),
        path.join(movedTitle, 'Chapter_2 - key-2'),
      ]);
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it('accepts a title or chapter folder picked instead of the folder above it', async () => {
    const titleDir = await newStyleTitle();

    const fromTitle = await scanForDownloadsToRestore(titleDir);
    const fromChapter = await scanForDownloadsToRestore(path.join(titleDir, 'Chapter_1 - key-1'));

    for (const scan of [fromTitle, fromChapter]) {
      expect(scan.roots).toEqual([root]);
      expect(scan.titles.map((title) => title.title)).toEqual(['New Title']);
    }
  });

  it('offers only incomplete or unidentifiable folders for deletion', async () => {
    await newStyleTitle();
    const stray = path.join(root, 'Unknown', 'Chapter_x');
    await chapterFolder(stray, 1);
    await utimes(stray, DAY_AGO, DAY_AGO);

    const orphans = await downloadService.getOrphanedDownloadFolders();

    expect(orphans.map((orphan) => `${orphan.title}/${orphan.chapterFolder}`).sort()).toEqual([
      'New Title [gone-src]/Chapter_3 - key-3',
      'Unknown/Chapter_x',
    ]);
  });
});
