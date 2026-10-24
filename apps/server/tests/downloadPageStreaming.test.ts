import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

vi.mock('axios', () => ({ default: { get: vi.fn() } }));
vi.mock('../src/utils/ssrfGuard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/ssrfGuard.js')>();
  return { ...actual, assertPublicHttpUrl: vi.fn().mockResolvedValue(undefined) };
});

import axios from 'axios';
import downloadService from '../src/services/download.service.js';
import downloadRepository from '../src/repositories/download.repository.js';

let directory: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'manga-download-page-test-'));
  downloadService.setDownloadDir(directory);
});

afterEach(async () => {
  vi.mocked(axios.get).mockReset();
  await fs.rm(directory, { recursive: true, force: true });
});

describe('chapter page streaming', () => {
  it('does not assume zero usage when storage cannot be scanned', async () => {
    downloadService.invalidateDownloadStorageUsage();
    const scan = vi
      .spyOn(fs, 'readdir')
      .mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));
    try {
      await expect(
        downloadService.initiateDownload({
          sourceId: 'source',
          mangaSlug: 'slug',
          chapterId: 'chapter',
          mangaTitle: 'Title',
          chapterTitle: 'Chapter',
          chapterNumber: 1,
        }),
      ).rejects.toThrow('Failed to initiate download');
    } finally {
      scan.mockRestore();
    }
  });
  it('streams a page to a finished file', async () => {
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0x01, 0x02]);
    vi.mocked(axios.get).mockResolvedValueOnce({ data: Readable.from([bytes]) });

    await downloadService.downloadPageWithRetry(
      'download-1',
      'https://example.com/page.jpg',
      1,
      'Chapter_1',
      new AbortController().signal,
      0,
    );

    expect(await fs.readFile(path.join(directory, 'Chapter_1', 'page_001.jpg'))).toEqual(bytes);
    expect(vi.mocked(axios.get).mock.calls[0]?.[1]).toMatchObject({ responseType: 'stream' });
  });

  it('does not serve a matching page from an unapproved persisted directory', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'manga-download-outside-'));
    await fs.writeFile(path.join(outside, 'page_001.jpg'), Buffer.from([0xff, 0xd8, 0xff]));
    const lookup = vi
      .spyOn(downloadRepository, 'getDownloadByChapterId')
      .mockResolvedValue({ status: 'COMPLETED', downloaded_path: outside } as never);
    try {
      await expect(downloadService.getDownloadedPageFile('chapter-1', 0)).rejects.toThrow(
        'outside the configured download folders',
      );
      expect(await fs.readFile(path.join(outside, 'page_001.jpg'))).toEqual(
        Buffer.from([0xff, 0xd8, 0xff]),
      );
    } finally {
      lookup.mockRestore();
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('does not return an unapproved persisted path to the downloads UI', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'manga-download-path-leak-'));
    const lookup = vi.spyOn(downloadRepository, 'getAllDownloads').mockResolvedValue([
      {
        status: 'COMPLETED',
        downloaded_path: outside,
        file_path: outside,
        manga: { slug: 'slug', title: 'Title' },
        chapter: { name: 'Chapter', chapter_number: 1 },
      },
    ] as never);
    try {
      const [download] = await downloadService.getAllDownloads();
      expect(download.filePath).toBe('');
      expect(download.downloaded_path).toBe('');
    } finally {
      lookup.mockRestore();
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('saves a PNG with its real extension and rejects an HTML response', async () => {
    const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
    vi.mocked(axios.get).mockResolvedValueOnce({ data: Readable.from([png]) });
    await downloadService.downloadPageWithRetry(
      'download-1',
      'https://example.com/page',
      2,
      'Chapter_1',
      new AbortController().signal,
      0,
    );
    expect(await fs.readFile(path.join(directory, 'Chapter_1', 'page_002.png'))).toEqual(png);

    vi.mocked(axios.get).mockResolvedValueOnce({
      data: Readable.from([Buffer.from('<html>blocked</html>')]),
    });
    const failure = await downloadService
      .downloadPageWithRetry(
        'download-1',
        'https://example.com/page?token=fixture-secret',
        3,
        'Chapter_1',
        new AbortController().signal,
        0,
      )
      .catch((error: unknown) => error);
    expect(failure.message).toBe('DOWNLOAD_PAGE_FAILED: Page 3 failed after 1 attempts.');
    expect(failure.message).not.toContain('fixture-secret');
    expect(await fs.readdir(path.join(directory, 'Chapter_1'))).toEqual(['page_002.png']);
  });

  it('rejects an oversized page without creating a completed file or retrying', async () => {
    vi.mocked(axios.get).mockResolvedValueOnce({
      data: Readable.from([Buffer.alloc(50 * 1024 * 1024 + 1)]),
    });

    await expect(
      downloadService.downloadPageWithRetry(
        'download-1',
        'https://example.com/page.jpg',
        1,
        'Chapter_1',
        new AbortController().signal,
        3,
      ),
    ).rejects.toThrow('50 MB limit');

    expect(axios.get).toHaveBeenCalledTimes(1);
    await expect(fs.access(path.join(directory, 'Chapter_1', 'page_001.jpg'))).rejects.toThrow();
  });
});
