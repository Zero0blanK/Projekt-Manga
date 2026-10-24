import fs from 'fs/promises';
import path from 'path';

const thumbnailsPath = path.resolve(process.cwd(), 'data', 'thumbnails');
const legacyThumbnailsPath = path.resolve(process.cwd(), 'public', 'extension', 'thumbnails');
const PRIVATE_PREFIX = '/cache-assets/';
const LEGACY_PREFIX = '/extension/thumbnails/';

const fileFor = (key: string, root: string): string => {
  if (!/^[a-zA-Z0-9_-]+\.(?:jpg|png|gif|webp|avif)$/.test(key)) {
    throw new Error('Invalid thumbnail key');
  }
  return path.join(root, key);
};

export const ensureThumbnailsDir = async () => {
  await fs.mkdir(thumbnailsPath, { recursive: true });
  return thumbnailsPath;
};

export const uploadBuffer = async (buf: Buffer, key: string): Promise<string> => {
  await ensureThumbnailsDir();
  const filePath = fileFor(key, thumbnailsPath);
  await fs.writeFile(filePath, buf, { flag: 'wx' });
  return `${PRIVATE_PREFIX}${key}`;
};

export const resolveCachedThumbnail = (url: string): string => {
  if (url.startsWith(PRIVATE_PREFIX)) {
    return fileFor(url.slice(PRIVATE_PREFIX.length), thumbnailsPath);
  }
  if (url.startsWith(LEGACY_PREFIX)) {
    return fileFor(url.slice(LEGACY_PREFIX.length), legacyThumbnailsPath);
  }
  throw new Error('Invalid cached thumbnail URL');
};

export const removeCachedThumbnail = async (url: string): Promise<void> => {
  // Existing legacy files may be tracked or shared; never delete them automatically.
  if (!url.startsWith(PRIVATE_PREFIX)) return;
  await fs.rm(resolveCachedThumbnail(url), { force: true });
};

/** Only private generated assets are eligible; the legacy public folder is untouched. */
export const pruneOrphanedThumbnails = async (referencedUrls: Set<string>): Promise<number> => {
  let entries;
  try {
    entries = await fs.readdir(thumbnailsPath, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  let removed = 0;
  const oldestSafeTime = Date.now() - 24 * 60 * 60 * 1000;
  for (const entry of entries) {
    if (!entry.isFile() || !/^[a-zA-Z0-9_-]+\.(?:jpg|png|gif|webp|avif)$/.test(entry.name))
      continue;
    if (referencedUrls.has(`${PRIVATE_PREFIX}${entry.name}`)) continue;
    const file = fileFor(entry.name, thumbnailsPath);
    const stat = await fs.stat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (stat && stat.mtimeMs < oldestSafeTime) {
      await fs.rm(file, { force: true });
      removed++;
    }
  }
  return removed;
};

export default {
  uploadBuffer,
  resolveCachedThumbnail,
  removeCachedThumbnail,
  pruneOrphanedThumbnails,
};
