import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/**
 * What a downloaded chapter folder says about itself, so it can be found again.
 *
 * The database is what ties a folder of pages to a source, a title and a chapter. Lose it
 * (app data deleted, a new computer, a new Windows account) and the pages are still there
 * with nothing saying what they are, beyond a folder name that keeps only part of the
 * chapter's key. From now on every finished chapter gets a small file beside its pages, and
 * every title folder one beside its chapters. Restoring (services/downloadRestore.service.ts)
 * reads them back; older downloads fall back to their folder names.
 *
 * Dot-prefixed so comic readers pointed at the folder see only the pages.
 */
export const CHAPTER_IDENTITY_FILE = '.projektmanga-chapter.json';
export const TITLE_IDENTITY_FILE = '.projektmanga-title.json';

export const PAGE_FILE = /^page_(\d+)\.(?:jpg|png|gif|webp|avif)$/i;

/** Strips characters that are invalid in filenames on Windows/POSIX and neutralizes
 * path-separator characters so a crafted title can never add extra path segments
 * (and therefore can't escape the download directory via `..`). */
export function sanitizePathSegment(value: string): string {
  const cleaned = value
    // The control-character range is deliberate, not a stray escape: a chapter
    // title scraped from a source can carry them, and they are illegal in
    // filenames on every platform this runs on.
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/^\.+/, '_')
    .trim();
  return cleaned.length > 0 ? cleaned : 'untitled';
}

/** The part of a chapter key a folder name keeps (download.service's generateFilePath). */
export function folderKeySuffix(chapterKey: string): string {
  return sanitizePathSegment(chapterKey).slice(-24);
}

const text = (max: number) => z.string().trim().min(1).max(max);

const chapterIdentitySchema = z.object({
  format: z.literal(1),
  source: text(200),
  mangaSlug: text(1000),
  mangaTitle: text(1000),
  chapterKey: text(2000),
  chapterNumber: z.number().finite().min(0),
  chapterName: z.string().max(1000).nullable().optional(),
  scanlator: z.string().max(1000).nullable().optional(),
  /** Pages the chapter has. Fewer page files than this means the folder is incomplete. */
  pageCount: z.number().int().min(1).max(100_000),
});
export type ChapterIdentity = z.infer<typeof chapterIdentitySchema>;

const titleIdentitySchema = z.object({
  format: z.literal(1),
  source: text(200),
  slug: text(1000),
  title: text(1000),
  author: z.string().max(1000).nullable().optional(),
  thumbnailUrl: z.string().max(4000).nullable().optional(),
});
export type TitleIdentity = z.infer<typeof titleIdentitySchema>;

/** Writes beside the target first, then renames, so a crash never leaves half a file. */
async function writeJsonAtomically(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
    await fsp.rename(temporary, file);
  } finally {
    await fsp.rm(temporary, { force: true });
  }
}

export async function writeChapterIdentity(
  chapterDir: string,
  identity: Omit<ChapterIdentity, 'format'>,
): Promise<void> {
  await writeJsonAtomically(path.join(chapterDir, CHAPTER_IDENTITY_FILE), {
    format: 1,
    ...identity,
  });
}

export async function writeTitleIdentity(
  titleDir: string,
  identity: Omit<TitleIdentity, 'format'>,
): Promise<void> {
  await writeJsonAtomically(path.join(titleDir, TITLE_IDENTITY_FILE), { format: 1, ...identity });
}

/** The file's contents, or null when it is missing, unreadable or not one of ours. */
async function readJson<T>(file: string, schema: z.ZodType<T>): Promise<T | null> {
  try {
    const stat = await fsp.lstat(file);
    // Small by construction; anything large was not written by this app.
    if (!stat.isFile() || stat.size > 64 * 1024) return null;
    const parsed = schema.safeParse(JSON.parse(await fsp.readFile(file, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export const readChapterIdentity = (chapterDir: string) =>
  readJson(path.join(chapterDir, CHAPTER_IDENTITY_FILE), chapterIdentitySchema);

export const readTitleIdentity = (titleDir: string) =>
  readJson(path.join(titleDir, TITLE_IDENTITY_FILE), titleIdentitySchema);

/** `"Some Title [source-id]"`, as every released version has named a title folder. */
export function parseTitleFolder(name: string): { title: string; source: string } | null {
  const match = /^(.*\S)\s*\[([^[\]]+)\]$/.exec(name);
  if (!match) return null;
  return { title: match[1], source: match[2] };
}

/** `"Chapter_12.5 - <last 24 characters of the chapter key>"`. */
export function parseChapterFolder(name: string): { number: number; keySuffix: string } | null {
  const match = /^Chapter_(\d+(?:\.\d+)?) - (.+)$/.exec(name);
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isFinite(number) ? { number, keySuffix: match[2] } : null;
}

export interface PageFiles {
  /** Page files present. */
  count: number;
  /** Highest page number present, so gaps can be seen: count < highest. */
  highest: number;
  sizeBytes: number;
}

export async function listPageFiles(chapterDir: string): Promise<PageFiles> {
  const entries = await fsp.readdir(chapterDir, { withFileTypes: true }).catch(() => []);
  let count = 0;
  let highest = 0;
  let sizeBytes = 0;
  for (const entry of entries) {
    const match = PAGE_FILE.exec(entry.name);
    if (!match || !entry.isFile()) continue;
    try {
      const stat = await fsp.lstat(path.join(chapterDir, entry.name));
      if (!stat.isFile()) continue;
      count += 1;
      sizeBytes += stat.size;
      highest = Math.max(highest, Number(match[1]));
    } catch {
      // Removed while listing: not part of the folder.
    }
  }
  return { count, highest, sizeBytes };
}

export interface IdentifiedChapterFolder {
  /** From the chapter's info file, when it has one: exact. */
  identity: ChapterIdentity | null;
  /** From the folder names alone, for downloads made before info files existed. */
  legacy: { source: string; title: string; number: number; keySuffix: string } | null;
  pages: PageFiles;
  /**
   * Every page from 1 up is present (and as many as the info file says, when there is one).
   * The Downloads list holds a finished chapter to the same rule, so a folder with gaps
   * would only come back looking failed.
   */
  complete: boolean;
}

export async function identifyChapterFolder(chapterDir: string): Promise<IdentifiedChapterFolder> {
  const [identity, pages] = await Promise.all([
    readChapterIdentity(chapterDir),
    listPageFiles(chapterDir),
  ]);
  const titleFolder = parseTitleFolder(path.basename(path.dirname(chapterDir)));
  const chapterFolder = parseChapterFolder(path.basename(chapterDir));
  const legacy =
    titleFolder && chapterFolder
      ? {
          source: titleFolder.source,
          title: titleFolder.title,
          number: chapterFolder.number,
          keySuffix: chapterFolder.keySuffix,
        }
      : null;
  const complete =
    pages.count > 0 &&
    pages.count === pages.highest &&
    (identity === null || pages.count >= identity.pageCount);
  return { identity, legacy, pages, complete };
}

/** A complete chapter folder that says, or whose name says, what it is. */
export async function isRestorableChapterFolder(chapterDir: string): Promise<boolean> {
  const folder = await identifyChapterFolder(chapterDir);
  return folder.complete && (folder.identity !== null || folder.legacy !== null);
}
