import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CHAPTER_IDENTITY_FILE,
  folderKeySuffix,
  identifyChapterFolder,
  isRestorableChapterFolder,
  parseChapterFolder,
  parseTitleFolder,
  readChapterIdentity,
  writeChapterIdentity,
} from '../src/utils/downloadIdentity.js';

let root = '';
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = '';
});

async function pages(dir: string, numbers: number[]) {
  await mkdir(dir, { recursive: true });
  for (const n of numbers)
    await writeFile(path.join(dir, `page_${String(n).padStart(3, '0')}.png`), 'x');
}

describe('download folder names', () => {
  it('reads the source and title back from a title folder', () => {
    expect(parseTitleFolder('Solo Leveling [mangadex]')).toEqual({
      title: 'Solo Leveling',
      source: 'mangadex',
    });
    expect(parseTitleFolder('Title with [brackets] inside [src]')).toEqual({
      title: 'Title with [brackets] inside',
      source: 'src',
    });
    // Cut at 120 characters before the source survived: not identifiable.
    expect(parseTitleFolder('A very long title that was cut')).toBeNull();
  });

  it('reads the number and key ending back from a chapter folder', () => {
    expect(parseChapterFolder('Chapter_82.5 - 5f1c2a')).toEqual({
      number: 82.5,
      keySuffix: '5f1c2a',
    });
    expect(parseChapterFolder('Chapter_3 - a - b')).toEqual({ number: 3, keySuffix: 'a - b' });
    expect(parseChapterFolder('Extras')).toBeNull();
  });

  it('keeps the same end of a chapter key the download folder does', () => {
    expect(folderKeySuffix('https://site.example/chapter/12345')).toBe('te.example_chapter_12345');
    expect(folderKeySuffix('short')).toBe('short');
  });
});

describe('identifying a chapter folder', () => {
  it('trusts the info file, and needs every page it lists', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'pm-identity-'));
    const dir = path.join(root, 'Title [src]', 'Chapter_1 - key');
    await pages(dir, [1, 2, 3]);
    await writeChapterIdentity(dir, {
      source: 'src',
      mangaSlug: 'title',
      mangaTitle: 'Title',
      chapterKey: 'full-key',
      chapterNumber: 1,
      pageCount: 4,
    });

    const short = await identifyChapterFolder(dir);
    expect(short.identity?.chapterKey).toBe('full-key');
    expect(short.complete).toBe(false);

    await pages(dir, [4]);
    expect((await identifyChapterFolder(dir)).complete).toBe(true);
    expect(await isRestorableChapterFolder(dir)).toBe(true);
  });

  it('treats a folder with a gap in its pages as incomplete', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'pm-identity-'));
    const dir = path.join(root, 'Title [src]', 'Chapter_2 - key');
    await pages(dir, [1, 3]);
    const folder = await identifyChapterFolder(dir);
    expect(folder.legacy).toEqual({ source: 'src', title: 'Title', number: 2, keySuffix: 'key' });
    expect(folder.complete).toBe(false);
    expect(await isRestorableChapterFolder(dir)).toBe(false);
  });

  it('ignores an info file that is not one of ours', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'pm-identity-'));
    const dir = path.join(root, 'Photos', 'Trip');
    await pages(dir, [1]);
    await writeFile(path.join(dir, CHAPTER_IDENTITY_FILE), '{"format":2,"source":"x"}');
    expect(await readChapterIdentity(dir)).toBeNull();
    expect(await isRestorableChapterFolder(dir)).toBe(false);
  });
});
