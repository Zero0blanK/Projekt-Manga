import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prismaMock } from './mocks/prismaMock.js';
import downloadService from '../src/services/download.service.js';
import downloadWorker from '../src/workers/download.worker.js';
import {
  CHAPTER_IDENTITY_FILE,
  TITLE_IDENTITY_FILE,
  isRestorableChapterFolder,
} from '../src/utils/downloadIdentity.js';

/**
 * A finished chapter records what it is beside its pages, so it can be restored if the
 * database is lost. The source and the page fetches are faked; nothing reaches the network.
 */
describe('a finished download', () => {
  let root = '';
  const previousRoot = downloadService.getDownloadDir();

  afterEach(async () => {
    vi.restoreAllMocks();
    downloadService.setDownloadDir(previousRoot);
    if (root) await rm(root, { recursive: true, force: true });
    root = '';
  });

  it('writes the chapter and title info files beside its pages', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'pm-identity-write-'));
    downloadService.setDownloadDir(root);
    const filePath = 'A Title [src]/Chapter_4 - the-key';
    vi.spyOn(downloadService, 'downloadPageWithRetry').mockImplementation(
      async (_url: string, page: number, relative: string) => {
        const dir = path.join(root, relative);
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, `page_${String(page).padStart(3, '0')}.jpg`), 'jpg');
        return undefined as never;
      },
    );
    prismaMock.download.update.mockResolvedValue({} as never);
    const chapter = {
      id: 'chapter-row',
      source_chapter_key: 'the-full-chapter-key',
      chapter_number: 4,
      name: 'Four',
      scanlator: 'Group',
      url: 'https://source.invalid/c/4',
      manga: {
        id: 'manga-row',
        source: 'src',
        slug: 'a-title',
        title: 'A Title',
        author: 'Author',
        thumbnail_url: 'https://source.invalid/cover.jpg',
      },
    };
    const source = {
      base_url: 'https://source.invalid',
      fetchChapterPages: async () => ({
        items: [
          { image_url: 'https://source.invalid/1.jpg' },
          { image_url: 'https://source.invalid/2.jpg' },
        ],
      }),
    };
    const worker = downloadWorker as unknown as {
      downloadChapterPages: (...args: unknown[]) => Promise<void>;
      assertDiskSpaceAvailable: () => Promise<void>;
    };
    vi.spyOn(worker, 'assertDiskSpaceAvailable').mockResolvedValue();

    await worker.downloadChapterPages(
      'download-1',
      { id: 'download-1', file_path: filePath },
      chapter,
      source,
    );

    const chapterDir = path.join(root, filePath);
    expect(
      JSON.parse(await readFile(path.join(chapterDir, CHAPTER_IDENTITY_FILE), 'utf8')),
    ).toEqual({
      format: 1,
      source: 'src',
      mangaSlug: 'a-title',
      mangaTitle: 'A Title',
      chapterKey: 'the-full-chapter-key',
      chapterNumber: 4,
      chapterName: 'Four',
      scanlator: 'Group',
      pageCount: 2,
    });
    expect(
      JSON.parse(await readFile(path.join(root, 'A Title [src]', TITLE_IDENTITY_FILE), 'utf8')),
    ).toEqual({
      format: 1,
      source: 'src',
      slug: 'a-title',
      title: 'A Title',
      author: 'Author',
      thumbnailUrl: 'https://source.invalid/cover.jpg',
    });
    expect(await isRestorableChapterFolder(chapterDir)).toBe(true);
  });
});
