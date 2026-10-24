import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prismaMock } from './mocks/prismaMock.js';
import downloadService from '../src/services/download.service.js';

describe('completed download reconciliation', () => {
  let root: string | null = null;
  let previousRoot = downloadService.getDownloadDir();

  afterEach(async () => {
    downloadService.setDownloadDir(previousRoot);
    if (root) await rm(root, { recursive: true, force: true });
    root = null;
    vi.clearAllMocks();
  });

  it('withholds completed folders with missing page files as cleanup candidates', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'manga-download-completion-'));
    previousRoot = downloadService.getDownloadDir();
    downloadService.setDownloadDir(root);
    const healthy = path.join(root, 'Healthy', 'Chapter_1');
    const partial = path.join(root, 'Partial', 'Chapter_2');
    await mkdir(healthy, { recursive: true });
    await mkdir(partial, { recursive: true });
    await writeFile(path.join(healthy, 'page_001.jpg'), 'page');
    await writeFile(path.join(partial, 'page_001.jpg'), 'page');

    const makeRow = (id: string, directory: string, pages: number) => ({
      id,
      manga_id: `manga-${id}`,
      chapter_id: `chapter-${id}`,
      source_id: 'test-source',
      file_path: path.relative(root!, directory),
      downloaded_path: directory,
      status: 'COMPLETED',
      pages_total: pages,
      pages_downloaded: pages,
      current_page: pages,
      created_at: new Date(),
      started_at: new Date(),
      completed_at: new Date(),
      manga: { slug: id, title: id },
      chapter: { name: `Chapter ${id}`, chapter_number: pages },
    });
    prismaMock.download.findMany.mockResolvedValueOnce([
      makeRow('healthy', healthy, 1),
      makeRow('partial', partial, 2),
    ] as never);

    const downloads = await downloadService.getAllDownloads();
    expect(downloads.find((row) => row.id === 'healthy')?.downloaded_path).toBe(healthy);
    expect(downloads.find((row) => row.id === 'partial')?.downloaded_path).toBe('');
  });
});
