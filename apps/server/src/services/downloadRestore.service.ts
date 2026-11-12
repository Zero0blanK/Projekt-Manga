import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type {
  DownloadRestoreResult,
  DownloadRestoreScan,
  MangaDetails,
  RestorableTitle,
  RestorableTitleStatus,
} from '@projekt-manga/types';
import downloadService from './download.service.js';
import sourceService from './source.service.js';
import verifiedSource from './verifiedSource.service.js';
import downloadRepository from '../repositories/download.repository.js';
import chapterRepository from '../repositories/chapter.repository.js';
import mangaRepository from '../repositories/manga.repository.js';
import {
  CHAPTER_IDENTITY_FILE,
  folderKeySuffix,
  identifyChapterFolder,
  parseChapterFolder,
  readTitleIdentity,
  sanitizePathSegment,
  type IdentifiedChapterFolder,
  type TitleIdentity,
} from '../utils/downloadIdentity.js';
import { mapConcurrent } from '../utils/mapConcurrent.js';
import { ValidationError } from '../utils/customErrors.js';
import { announceLibraryChange, EVERYONE } from '../utils/libraryChanges.js';

/**
 * Finds downloads the app has no record of, and adds them back.
 *
 * The pages of a downloaded chapter outlive the database that knew what they were: app data
 * deleted, a new computer, a new Windows account, or a folder this install never used. This
 * walks the download folders (the ones the app knows, or one the user points at), works out
 * which source, title and chapter each folder is, and creates the records that make it a
 * download again. Nothing on disk is copied, moved or changed.
 *
 * A chapter is identified by the info file the download worker writes beside its pages
 * (utils/downloadIdentity.ts), or, for downloads made before that, by its folder names:
 * `Title [source]/Chapter_12 - <end of the chapter key>`. Those name the source and keep only
 * part of the chapter's key, so the title is looked up on its source to recover the rest,
 * which needs that source to be installed. Until it is, such a title waits rather than
 * coming back half-identified.
 */

interface FoundChapter {
  dir: string;
  root: string;
  folder: IdentifiedChapterFolder;
}

interface FoundTitle {
  id: string;
  dir: string;
  root: string;
  chapters: FoundChapter[];
}

type ChapterState = 'ready' | 'incomplete' | 'already' | 'unmatched';

interface ResolvedChapter {
  found: FoundChapter;
  key: string | null;
  number: number;
  name: string | null;
  scanlator: string | null;
  pages: number;
  state: ChapterState;
}

interface ResolvedTitle {
  found: FoundTitle;
  status: RestorableTitleStatus;
  source: string;
  slug: string | null;
  title: string;
  author: string | null;
  thumbnailUrl: string | null;
  /** The source's listing, when older downloads were matched against it. */
  details: MangaDetails | null;
  chapters: ResolvedChapter[];
}

/** A title folder holding more chapter folders than this is not one the app made. */
const MAX_CHAPTERS_PER_TITLE = 10_000;
/** Stops a folder chosen by mistake (a whole drive) from being walked for minutes. */
const MAX_TITLE_FOLDERS = 5_000;

function comparable(candidate: string): string {
  const resolved = path.resolve(candidate);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function titleIdOf(titleDir: string): string {
  return createHash('sha256').update(comparable(titleDir)).digest('hex');
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await fsp.stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

async function isChapterFolder(dir: string): Promise<boolean> {
  if (parseChapterFolder(path.basename(dir))) return true;
  try {
    return (await fsp.lstat(path.join(dir, CHAPTER_IDENTITY_FILE))).isFile();
  } catch {
    return false;
  }
}

/**
 * The download root for a folder the user picked.
 *
 * People pick the folder they recognise, which may be a title folder or even a chapter
 * folder rather than the root above them, so those are walked up from.
 */
async function rootForPickedFolder(picked: string): Promise<string> {
  if (!path.isAbsolute(picked)) throw new ValidationError('Enter a full folder path');
  let dir: string;
  try {
    dir = await fsp.realpath(picked);
  } catch {
    throw new ValidationError("That folder doesn't exist or can't be opened");
  }
  if (!(await isDirectory(dir))) throw new ValidationError('That is not a folder');
  if (await isChapterFolder(dir)) return path.dirname(path.dirname(dir));
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.slice(0, 200)) {
    if (entry.isDirectory() && (await isChapterFolder(path.join(dir, entry.name)))) {
      return path.dirname(dir);
    }
  }
  return dir;
}

async function walk(roots: string[]): Promise<FoundTitle[]> {
  const references = new Set(
    [...(await downloadService.getReferencedDownloadPaths())].map(comparable),
  );
  const titles = new Map<string, FoundTitle>();
  const seenChapters = new Set<string>();

  for (const rootPath of roots) {
    let root: string;
    try {
      root = await fsp.realpath(rootPath);
      if (!(await isDirectory(root))) continue;
    } catch {
      continue;
    }
    const titleEntries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const titleEntry of titleEntries.slice(0, MAX_TITLE_FOLDERS)) {
      if (!titleEntry.isDirectory()) continue;
      let titleDir: string;
      try {
        titleDir = await fsp.realpath(path.join(root, titleEntry.name));
      } catch {
        continue;
      }
      if (!isWithin(root, titleDir)) continue;

      const chapterEntries = await fsp.readdir(titleDir, { withFileTypes: true }).catch(() => []);
      for (const chapterEntry of chapterEntries.slice(0, MAX_CHAPTERS_PER_TITLE)) {
        if (!chapterEntry.isDirectory()) continue;
        let chapterDir: string;
        try {
          chapterDir = await fsp.realpath(path.join(titleDir, chapterEntry.name));
        } catch {
          continue;
        }
        if (!isWithin(titleDir, chapterDir)) continue;
        const key = comparable(chapterDir);
        // A folder some download row already points at is a download the app has.
        if (seenChapters.has(key) || references.has(key)) continue;
        seenChapters.add(key);
        if (!(await isChapterFolder(chapterDir))) continue;
        const folder = await identifyChapterFolder(chapterDir);
        if (!folder.identity && !folder.legacy) continue;

        const id = titleIdOf(titleDir);
        const title = titles.get(id) ?? { id, dir: titleDir, root, chapters: [] };
        title.chapters.push({ dir: chapterDir, root, folder });
        titles.set(id, title);
      }
    }
  }
  return [...titles.values()];
}

// ---------------------------------------------------------------- older downloads ----

type Lookup =
  | { kind: 'found'; details: MangaDetails; keyBySuffix: Map<string, string> }
  | { kind: 'not-found' }
  | { kind: 'failed' };

/** One lookup per title for a while: the Downloads page scans each time it opens. */
const LOOKUP_TTL_MS = 15 * 60_000;
const lookups = new Map<string, { at: number; result: Promise<Lookup> }>();

/**
 * Finds the title an older download folder came from, on its source.
 *
 * The folder keeps the title as written to disk (unsafe characters replaced) and the last 24
 * characters of each chapter's key. Search results are compared on the same written form,
 * and the one whose chapters account for the most folders wins.
 */
async function lookUpOnSource(
  source: string,
  folderTitle: string,
  suffixes: { keySuffix: string; number: number }[],
): Promise<Lookup> {
  const cacheKey = `${source}\u0000${folderTitle}`;
  const cached = lookups.get(cacheKey);
  if (cached && Date.now() - cached.at < LOOKUP_TTL_MS) return cached.result;

  const result = (async (): Promise<Lookup> => {
    try {
      const query = folderTitle.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
      const results = await sourceService.searchManga({
        sourceId: source,
        query,
        pagination: { limit: 20, offset: 0 },
      });
      const written = (title: string) => sanitizePathSegment(title).toLowerCase();
      const candidates = results
        .filter((candidate) => written(candidate.title) === folderTitle.toLowerCase())
        .slice(0, 3);
      let best: { details: MangaDetails; keyBySuffix: Map<string, string> } | null = null;
      for (const candidate of candidates) {
        const details = await sourceService.getMangaDetails(source, candidate.id);
        const bySuffix = new Map(details.chapters.map((c) => [folderKeySuffix(c.id), c]));
        const keyBySuffix = new Map<string, string>();
        for (const { keySuffix, number } of suffixes) {
          const chapter = bySuffix.get(keySuffix);
          if (chapter && Math.abs(chapter.chapter_number - number) < 1e-6) {
            keyBySuffix.set(keySuffix, chapter.id);
          }
        }
        if (keyBySuffix.size > (best?.keyBySuffix.size ?? 0)) {
          best = { details: { ...details, slug: details.slug || candidate.slug }, keyBySuffix };
        }
      }
      return best ? { kind: 'found', ...best } : { kind: 'not-found' };
    } catch {
      return { kind: 'failed' };
    }
  })();
  lookups.set(cacheKey, { at: Date.now(), result });
  const settled = await result;
  // A failure is worth trying again on the next scan rather than for fifteen minutes.
  if (settled.kind === 'failed') lookups.delete(cacheKey);
  return settled;
}

// ---------------------------------------------------------------- identification ----

async function existsAsFolder(candidate: string | null): Promise<boolean> {
  return candidate ? isDirectory(candidate) : false;
}

/** Whether this chapter already has a finished download whose folder is still there. */
async function alreadyDownloaded(source: string, slug: string, key: string): Promise<boolean> {
  const chapter = await chapterRepository.findChapterByKey({
    source,
    manga_slug: slug,
    source_chapter_key: key,
  });
  if (!chapter) return false;
  const downloads = await downloadRepository.getDownloadsByChapterId(chapter.id);
  for (const download of downloads) {
    if (download.status === 'COMPLETED' && (await existsAsFolder(download.downloaded_path))) {
      return true;
    }
  }
  return false;
}

async function resolveTitle(found: FoundTitle): Promise<ResolvedTitle> {
  const titleIdentity: TitleIdentity | null = await readTitleIdentity(found.dir);
  const firstIdentity = found.chapters.find((c) => c.folder.identity)?.folder.identity ?? null;
  const firstLegacy = found.chapters.find((c) => c.folder.legacy)?.folder.legacy ?? null;
  const source = titleIdentity?.source ?? firstIdentity?.source ?? firstLegacy?.source ?? '';
  let slug = titleIdentity?.slug ?? firstIdentity?.mangaSlug ?? null;
  let title = titleIdentity?.title ?? firstIdentity?.mangaTitle ?? firstLegacy?.title ?? found.dir;
  let author = titleIdentity?.author ?? null;
  let thumbnailUrl = titleIdentity?.thumbnailUrl ?? null;

  // Older downloads in this folder need their source to find their chapters' keys.
  const legacyChapters = found.chapters.filter((c) => !c.folder.identity && c.folder.legacy);
  let lookup: Lookup | null = null;
  let sourceMissing = false;
  if (legacyChapters.length > 0) {
    if (!(await verifiedSource.isInstalled(source))) {
      sourceMissing = true;
    } else {
      lookup = await lookUpOnSource(
        source,
        firstLegacy?.title ?? title,
        legacyChapters.map((c) => ({
          keySuffix: c.folder.legacy!.keySuffix,
          number: c.folder.legacy!.number,
        })),
      );
      if (lookup.kind === 'found') {
        slug ??= lookup.details.slug;
        title = lookup.details.title || title;
        author ??= lookup.details.author?.join(', ') || null;
        thumbnailUrl ??= lookup.details.thumbnail_url || null;
      }
    }
  }
  const details = lookup?.kind === 'found' ? lookup.details : null;
  const detailsByKey = new Map(details?.chapters.map((c) => [c.id, c]) ?? []);

  const chapters: ResolvedChapter[] = [];
  for (const chapter of found.chapters) {
    const { identity, legacy, complete, pages } = chapter.folder;
    const key =
      identity?.chapterKey ??
      (legacy && lookup?.kind === 'found'
        ? (lookup.keyBySuffix.get(legacy.keySuffix) ?? null)
        : null);
    const listed = key ? detailsByKey.get(key) : undefined;
    let state: ChapterState;
    if (!key || !slug) state = 'unmatched';
    else if (!complete) state = 'incomplete';
    else if (await alreadyDownloaded(source, slug, key)) state = 'already';
    else state = 'ready';
    chapters.push({
      found: chapter,
      key,
      number: identity?.chapterNumber ?? legacy?.number ?? 0,
      name: identity?.chapterName ?? listed?.name ?? null,
      scanlator: identity?.scanlator ?? listed?.scanlator ?? null,
      pages: pages.count,
      state,
    });
  }

  const count = (state: ChapterState) => chapters.filter((c) => c.state === state).length;
  let status: RestorableTitleStatus;
  if (count('ready') > 0) status = 'ready';
  else if (count('unmatched') > 0 && sourceMissing) status = 'needs-source';
  else if (count('unmatched') > 0 && lookup?.kind === 'failed') status = 'lookup-failed';
  else if (count('unmatched') > 0) status = 'not-found';
  else status = 'nothing-to-restore';

  return { found, status, source, slug, title, author, thumbnailUrl, details, chapters };
}

async function scanRoots(root: string | undefined): Promise<{
  roots: string[];
  titles: ResolvedTitle[];
}> {
  const roots = root ? [await rootForPickedFolder(root)] : downloadService.getKnownDownloadRoots();
  const found = await walk(roots);
  const titles = await mapConcurrent(found, 4, resolveTitle);
  return { roots, titles };
}

function toSummary(resolved: ResolvedTitle, sourceNames: Map<string, string>): RestorableTitle {
  const count = (state: ChapterState) =>
    resolved.chapters.filter((chapter) => chapter.state === state).length;
  return {
    id: resolved.found.id,
    source: resolved.source,
    sourceName: sourceNames.get(resolved.source) ?? null,
    title: resolved.title,
    thumbnailUrl: resolved.thumbnailUrl,
    folder: resolved.found.dir,
    status: resolved.status,
    chapters: {
      ready: count('ready'),
      incomplete: count('incomplete'),
      alreadyInApp: count('already'),
      unmatched: count('unmatched'),
    },
    sizeBytes: resolved.chapters.reduce((sum, c) => sum + c.found.folder.pages.sizeBytes, 0),
  };
}

const STATUS_ORDER: RestorableTitleStatus[] = [
  'ready',
  'lookup-failed',
  'needs-source',
  'not-found',
  'nothing-to-restore',
];

export async function scanForDownloadsToRestore(root?: string): Promise<DownloadRestoreScan> {
  const [{ roots, titles }, sources] = await Promise.all([
    scanRoots(root),
    sourceService.getSources().catch(() => []),
  ]);
  const sourceNames = new Map(sources.map((source) => [source.id, source.name]));
  const summaries = titles
    .map((title) => toSummary(title, sourceNames))
    .sort(
      (a, b) =>
        STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
        a.title.localeCompare(b.title),
    );
  return {
    roots,
    titles: summaries,
    restorableChapters: summaries.reduce((sum, title) => sum + title.chapters.ready, 0),
  };
}

// ----------------------------------------------------------------------- restoring ----

/** One restore at a time, so two clicks can't create the same chapter's record twice. */
let restoreLock: Promise<unknown> = Promise.resolve();

export function restoreDownloads(
  titleIds: string[],
  root?: string,
): Promise<DownloadRestoreResult> {
  const run = restoreLock.then(() => restoreNow(new Set(titleIds), root));
  restoreLock = run.catch(() => undefined);
  return run;
}

async function restoreNow(selected: Set<string>, root?: string): Promise<DownloadRestoreResult> {
  // Scanned again rather than trusting the caller's copy: folders may have changed since.
  const { titles } = await scanRoots(root);
  const result: DownloadRestoreResult = { restored: 0, relinked: 0, titles: [] };

  for (const resolved of titles) {
    if (!selected.has(resolved.found.id) || !resolved.slug) continue;
    const ready = resolved.chapters.filter((chapter) => chapter.state === 'ready');
    if (ready.length === 0) continue;

    downloadService.approveDownloadRoot(resolved.found.root);
    const details = resolved.details;
    // in_library false: creates the title's row, or reuses the one there is, without
    // adding it to anyone's library. The Downloads page does that, as the user chooses.
    const manga = await mangaRepository.addManga({
      source: resolved.source,
      slug: resolved.slug,
      title: resolved.title,
      author: resolved.author ?? 'Unknown',
      thumbnail_url: resolved.thumbnailUrl ?? '',
      description: details?.description ?? '',
      genres: details?.genres.join(', ') ?? '',
      status: details?.status ?? '',
      in_library: false,
      chapters: details?.chapters ?? [],
    });

    for (const chapter of ready) {
      const row = await chapterRepository.resolveChapter(
        { source: manga.source, manga_slug: manga.slug, source_chapter_key: chapter.key! },
        {
          chapter_number: chapter.number,
          name: chapter.name ?? undefined,
          scanlator: chapter.scanlator ?? undefined,
          page_count: chapter.pages,
        },
      );
      const placement = {
        file_path: path.relative(chapter.found.root, chapter.found.dir),
        downloaded_path: chapter.found.dir,
        pages: chapter.pages,
      };
      const existing = await downloadRepository.getDownloadsByChapterId(row.id);
      const usable = await Promise.all(
        existing.map(
          async (download) =>
            download.status === 'COMPLETED' && (await existsAsFolder(download.downloaded_path)),
        ),
      );
      if (usable.some(Boolean)) continue;
      if (existing[0]) {
        await downloadRepository.relinkDownload(existing[0].id, placement);
        result.relinked += 1;
      } else {
        await downloadRepository.createRestoredDownload({
          manga_id: manga.id,
          chapter_id: row.id,
          source_id: manga.source,
          ...placement,
        });
        result.restored += 1;
      }
    }
    result.titles.push({ id: resolved.found.id, mangaId: manga.id, title: manga.title });
  }

  if (result.restored + result.relinked > 0) {
    downloadService.invalidateDownloadStorageUsage();
    announceLibraryChange(EVERYONE, 'library');
  }
  return result;
}

/** For tests: forget cached source lookups. */
export function clearRestoreLookupCache(): void {
  lookups.clear();
}
