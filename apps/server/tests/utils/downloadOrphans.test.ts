import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  listOrphanedDownloadFolders,
  removeOrphanedDownloadFolder,
} from '../../src/utils/downloadOrphans.js';

const tempDirs: string[] = [];

async function makeTempDir() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'manga-download-orphans-'));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe('download orphan scanning', () => {
  it('lists only old, unreferenced chapter folders under an approved root', async () => {
    const root = await makeTempDir();
    const oldOrphan = path.join(root, 'Manga', 'Chapter_12');
    const referenced = path.join(root, 'Manga', 'Chapter_13');
    const recent = path.join(root, 'Manga', 'Chapter_14');
    await Promise.all(
      [oldOrphan, referenced, recent].map((directory) => fs.mkdir(directory, { recursive: true })),
    );
    await fs.writeFile(path.join(oldOrphan, 'page_001.jpg'), Buffer.alloc(12));
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await fs.utimes(oldOrphan, old, old);
    await fs.utimes(referenced, old, old);

    const result = await listOrphanedDownloadFolders([root], new Set([referenced]));

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      title: 'Manga',
      chapterFolder: 'Chapter_12',
      pageCount: 1,
      sizeBytes: 12,
    });
    // absolutePath is internal (the service strips it); nothing else may carry the path.
    // The basename check holds on Windows too, where JSON escaping hides `root` itself.
    const { absolutePath, ...publicFields } = result[0];
    expect(absolutePath).toBe(await fs.realpath(oldOrphan));
    expect(JSON.stringify(publicFields)).not.toContain(path.basename(root));
  });

  it('does not follow symlinked title directories outside the root', async (ctx) => {
    const parent = await makeTempDir();
    const root = path.join(parent, 'approved');
    const outside = path.join(parent, 'outside');
    await Promise.all([
      fs.mkdir(root),
      fs.mkdir(path.join(outside, 'Chapter_1'), { recursive: true }),
    ]);
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await fs.utimes(outside, old, old);
    try {
      await fs.symlink(outside, path.join(root, 'linked'), 'junction');
    } catch {
      ctx.skip();
      return;
    }

    expect(await listOrphanedDownloadFolders([root], new Set())).toEqual([]);
  });

  it('removes only the folder represented by the current opaque id', async () => {
    const root = await makeTempDir();
    const chapter = path.join(root, 'Manga', 'Chapter_2');
    await fs.mkdir(chapter, { recursive: true });
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await fs.utimes(chapter, old, old);
    const [candidate] = await listOrphanedDownloadFolders([root], new Set());

    await expect(removeOrphanedDownloadFolder(chapter, 'a'.repeat(64))).rejects.toThrow(
      'Orphan folder changed',
    );
    await removeOrphanedDownloadFolder(chapter, candidate.id);
    await expect(fs.access(chapter)).rejects.toThrow();
  });
});
