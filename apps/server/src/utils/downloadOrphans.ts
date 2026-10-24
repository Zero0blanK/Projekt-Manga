import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;
const PAGE_FILE = /^page_\d+\.(?:jpg|png|gif|webp|avif)$/i;

export interface OrphanedDownloadFolder {
  id: string;
  title: string;
  chapterFolder: string;
  pageCount: number;
  sizeBytes: number;
  modifiedAt: string;
}

export interface ScannedOrphanedDownloadFolder extends OrphanedDownloadFolder {
  absolutePath: string;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function folderId(canonicalPath: string): string {
  return createHash('sha256').update(canonicalPath).digest('hex');
}

function comparablePath(candidate: string): string {
  const resolved = path.resolve(candidate);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Scans only the title/chapter layout created by the download worker. */
export async function listOrphanedDownloadFolders(
  roots: string[],
  referencedPaths: ReadonlySet<string>,
  now = Date.now(),
): Promise<ScannedOrphanedDownloadFolder[]> {
  const references = new Set([...referencedPaths].map(comparablePath));
  const orphans: ScannedOrphanedDownloadFolder[] = [];

  for (const rootPath of roots) {
    let root: string;
    try {
      root = await fs.realpath(rootPath);
      if (!(await fs.stat(root)).isDirectory()) continue;
    } catch {
      continue;
    }

    const titleEntries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const titleEntry of titleEntries) {
      if (!titleEntry.isDirectory()) continue;
      const titlePath = path.join(root, titleEntry.name);
      let realTitle: string;
      try {
        realTitle = await fs.realpath(titlePath);
        if (!isWithin(root, realTitle) || !(await fs.stat(realTitle)).isDirectory()) continue;
      } catch {
        continue;
      }

      const chapterEntries = await fs.readdir(realTitle, { withFileTypes: true }).catch(() => []);
      for (const chapterEntry of chapterEntries) {
        if (!chapterEntry.isDirectory() || !/^Chapter_.+/.test(chapterEntry.name)) continue;
        const chapterPath = path.join(realTitle, chapterEntry.name);
        let realChapter: string;
        let directoryStat;
        try {
          realChapter = await fs.realpath(chapterPath);
          directoryStat = await fs.stat(realChapter);
          if (!isWithin(root, realChapter) || !directoryStat.isDirectory()) continue;
        } catch {
          continue;
        }

        if (now - directoryStat.mtimeMs < GRACE_PERIOD_MS) continue;
        if (references.has(comparablePath(realChapter))) continue;

        const files = await fs.readdir(realChapter, { withFileTypes: true }).catch(() => []);
        let pageCount = 0;
        let sizeBytes = 0;
        for (const file of files) {
          if (!PAGE_FILE.test(file.name) || !file.isFile()) continue;
          const filePath = path.join(realChapter, file.name);
          try {
            const stat = await fs.lstat(filePath);
            if (!stat.isFile()) continue;
            pageCount += 1;
            sizeBytes += stat.size;
          } catch {
            // A page removed while scanning is not part of the cleanup estimate.
          }
        }

        orphans.push({
          id: folderId(realChapter),
          absolutePath: realChapter,
          title: titleEntry.name,
          chapterFolder: chapterEntry.name,
          pageCount,
          sizeBytes,
          modifiedAt: directoryStat.mtime.toISOString(),
        });
      }
    }
  }

  return orphans.sort((left, right) => left.modifiedAt.localeCompare(right.modifiedAt));
}

export function removeOrphanedDownloadFolder(candidatePath: string, id: string): Promise<void> {
  return fs.realpath(candidatePath).then(async (canonicalPath) => {
    if (folderId(canonicalPath) !== id) throw new Error('Orphan folder changed; refresh the list');
    await fs.rm(canonicalPath, { recursive: true, force: false });
  });
}
