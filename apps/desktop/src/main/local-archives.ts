import { app, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as yauzl from 'yauzl';
import { imageSize } from 'image-size';
import { getCachedSession } from './auth-cache';
import {
  COMIC_INFO_LIMIT,
  comicDisplayTitle,
  epubPageOrder,
  isImageName,
  naturalCompare,
  parseComicInfo,
  type ComicInfo,
} from './local-archive-formats';

/** A comic copied into the app (the "Import" button) may be at most this large. */
const COMPRESSED_LIMIT = 100 * 1024 * 1024;
/** One read in place from a library folder is never unpacked whole, so it may be larger. */
const LINKED_ARCHIVE_LIMIT = 4 * 1024 * 1024 * 1024;
const EXPANDED_LIMIT = 500 * 1024 * 1024;
const IMAGE_LIMIT = 32 * 1024 * 1024;
const PIXEL_LIMIT = 16_000_000;
const DIMENSION_LIMIT = 16_384;
const PAGE_LIMIT = 2000;
const ENTRY_LIMIT = 4000;
/** An EPUB's package and page documents, read only to find the reading order. */
const DOCUMENT_LIMIT = 1024 * 1024;
const DOCUMENTS_TOTAL_LIMIT = 8 * 1024 * 1024;
const LIBRARY_FOLDER_LIMIT = 20;
const LIBRARY_ITEM_LIMIT = 5000;
const ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const PAGE_PATTERN = /^\d+\.(?:jpg|jpeg|png|webp)$/;
const ARCHIVE_EXTENSIONS = ['.cbz', '.zip', '.epub'];
/** EPUB parts that are not pages: skipped, never unpacked or shown. */
const EPUB_SKIPPED = ['.css', '.ncx', '.xml', '.txt', '.otf', '.ttf', '.woff', '.woff2', '.js'];
const EPUB_DOCUMENTS = ['.opf', '.xhtml', '.html', '.htm'];

type ArchiveKind = 'zip' | 'epub';
/** Where a comic read in place lives. Checked again on every page read. */
type ArchiveSource = { kind: 'zip' | 'folder'; path: string; size: number; mtimeMs: number };
type ArchiveManifest = {
  id: string;
  title: string;
  importedAt: string;
  /** Copied comics: the managed files ("0.png"). Read in place: names in the source. */
  pages: string[];
  info?: ComicInfo;
  series?: string;
  source?: ArchiveSource;
  /** The library folder a comic read in place was found in. */
  libraryFolder?: string;
};
type ArchiveSummary = {
  id: string;
  title: string;
  importedAt: string;
  pageCount: number;
  series?: string;
  writer?: string;
  /** Read in place from a library folder rather than copied. */
  linked?: boolean;
};

function profileDirectory(): string {
  const owner = getCachedSession()?.user_id ?? 'anonymous';
  return path.join(
    app.getPath('userData'),
    'local-archives',
    createHash('sha256').update(owner).digest('hex'),
  );
}

function archiveDirectory(root: string, id: unknown): string {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new Error('Invalid local archive');
  const directory = path.resolve(root, id);
  if (path.dirname(directory) !== path.resolve(root)) throw new Error('Invalid local archive');
  return directory;
}

async function ensureRoot(root: string): Promise<void> {
  const userData = app.getPath('userData');
  for (const directory of [path.join(userData, 'local-archives'), root]) {
    await fs.mkdir(directory, { recursive: true });
    const status = await fs.lstat(directory);
    if (!status.isDirectory() || status.isSymbolicLink())
      throw new Error('Local archive storage is unavailable.');
  }
  const trusted = await fs.realpath(userData);
  const resolved = await fs.realpath(root);
  if (path.dirname(path.dirname(resolved)) !== trusted)
    throw new Error('Local archive storage is unavailable.');
}

function requireSameProfile(root: string): void {
  if (root !== profileDirectory()) throw new Error('The account changed. Please try again.');
}

/** A name inside a comic read in place: a plain relative path to an image, nothing that
 * could climb out of the archive or folder. */
function safeSourceName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 512 &&
    !name.includes('\\') &&
    !name.includes('\0') &&
    !name.startsWith('/') &&
    !/^[a-z]:/i.test(name) &&
    !name.split('/').some((segment) => segment === '..' || segment === '.' || segment === '') &&
    isImageName(name)
  );
}

const optionalText = (value: unknown, limit: number) =>
  value === undefined || (typeof value === 'string' && value.length <= limit);

function validInfo(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object') return false;
  const info = value as Record<string, unknown>;
  return (
    optionalText(info.series, 200) &&
    optionalText(info.number, 20) &&
    optionalText(info.title, 200) &&
    optionalText(info.writer, 200) &&
    optionalText(info.summary, 4000) &&
    (info.genres === undefined ||
      (Array.isArray(info.genres) &&
        info.genres.length <= 20 &&
        info.genres.every((genre) => typeof genre === 'string' && genre.length <= 100)))
  );
}

function validSource(value: unknown): value is ArchiveSource {
  if (!value || typeof value !== 'object') return false;
  const source = value as Record<string, unknown>;
  return (
    (source.kind === 'zip' || source.kind === 'folder') &&
    typeof source.path === 'string' &&
    path.isAbsolute(source.path) &&
    source.path.length <= 4096 &&
    Number.isFinite(source.size) &&
    Number.isFinite(source.mtimeMs)
  );
}

async function readManifest(root: string, id: unknown): Promise<ArchiveManifest> {
  await ensureRoot(root);
  const directory = archiveDirectory(root, id);
  const status = await fs.lstat(directory);
  if (!status.isDirectory() || status.isSymbolicLink()) throw new Error('Invalid local archive');
  const metadata = path.join(directory, 'manifest.json');
  const metadataStatus = await fs.lstat(metadata);
  if (
    !metadataStatus.isFile() ||
    metadataStatus.isSymbolicLink() ||
    metadataStatus.size > 512 * 1024
  )
    throw new Error('Invalid local archive');
  const data: unknown = JSON.parse(await fs.readFile(metadata, 'utf8'));
  if (!data || typeof data !== 'object') throw new Error('Invalid local archive');
  const raw = data as Record<string, unknown>;
  const linked = raw.source !== undefined;
  if (
    raw.id !== id ||
    typeof raw.title !== 'string' ||
    raw.title.length > 200 ||
    typeof raw.importedAt !== 'string' ||
    !Array.isArray(raw.pages) ||
    raw.pages.length < 1 ||
    raw.pages.length > PAGE_LIMIT ||
    !raw.pages.every((page) =>
      linked ? safeSourceName(page) : typeof page === 'string' && PAGE_PATTERN.test(page),
    ) ||
    new Set(raw.pages).size !== raw.pages.length ||
    !validInfo(raw.info) ||
    !optionalText(raw.series, 200) ||
    (linked && !validSource(raw.source)) ||
    (raw.libraryFolder !== undefined && typeof raw.libraryFolder !== 'string')
  )
    throw new Error('Invalid local archive');
  return raw as ArchiveManifest;
}

function summary(manifest: ArchiveManifest): ArchiveSummary {
  return {
    id: manifest.id,
    title: manifest.title,
    importedAt: manifest.importedAt,
    pageCount: manifest.pages.length,
    ...(manifest.series && { series: manifest.series }),
    ...(manifest.info?.writer && { writer: manifest.info.writer }),
    ...(manifest.source && { linked: true }),
  };
}

function openZip(file: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) =>
    yauzl.open(
      file,
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true, autoClose: false },
      (error, zip) =>
        error || !zip
          ? reject(new Error('The selected file is not a readable comic archive.'))
          : resolve(zip),
    ),
  );
}

function nextEntry(zip: yauzl.ZipFile): Promise<yauzl.Entry | null> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      zip.off('entry', onEntry);
      zip.off('end', onEnd);
      zip.off('error', onError);
    };
    const onEntry = (entry: yauzl.Entry) => {
      cleanup();
      resolve(entry);
    };
    const onEnd = () => {
      cleanup();
      resolve(null);
    };
    const onError = () => {
      cleanup();
      reject(new Error('The comic archive is damaged.'));
    };
    zip.once('entry', onEntry);
    zip.once('end', onEnd);
    zip.once('error', onError);
    zip.readEntry();
  });
}

function entryStream(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Readable> {
  return new Promise((resolve, reject) =>
    zip.openReadStream(entry, (error, stream) =>
      error || !stream ? reject(new Error('A comic page could not be read.')) : resolve(stream),
    ),
  );
}

function imageType(bytes: Buffer): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP')
    return 'image/webp';
  return null;
}

function validateImage(bytes: Buffer): string {
  const mime = imageType(bytes);
  if (!mime) throw new Error('A comic page is not a supported image.');
  const { width, height } = imageSize(bytes);
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > DIMENSION_LIMIT ||
    height > DIMENSION_LIMIT ||
    width * height > PIXEL_LIMIT
  )
    throw new Error('Pages must be at most 16 megapixels and 16,384 pixels per dimension.');
  return mime;
}

const expectedType = (name: string) => {
  const extension = path.extname(name).toLowerCase();
  return extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : 'image/jpeg';
};

/** The same checks for every entry, whichever way the archive is used. */
function checkEntry(entry: yauzl.Entry): void {
  if (
    ![entry.uncompressedSize, entry.compressedSize].every(
      (size) => Number.isSafeInteger(size) && size >= 0,
    )
  )
    throw new Error('The archive has invalid entry sizes.');
  const name = entry.fileName;
  const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
  if (
    (entry.generalPurposeBitFlag & 0x41) !== 0 ||
    (mode !== 0 && mode !== 0x8000 && mode !== 0x4000) ||
    name.includes('\\') ||
    name.includes('\0') ||
    name.startsWith('/') ||
    /^[a-z]:/i.test(name) ||
    name.split('/').some((segment) => segment === '..' || segment === '.')
  )
    throw new Error('Encrypted entries, links and unsafe paths are not supported.');
}

/** An entry read into memory, never past `limit` bytes whatever the header claims. */
async function readEntry(zip: yauzl.ZipFile, entry: yauzl.Entry, limit: number): Promise<Buffer> {
  if (entry.uncompressedSize > limit) throw new Error('An archive entry is too large.');
  const stream = await entryStream(zip, entry);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > limit) {
      stream.destroy();
      throw new Error('An archive entry is too large.');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** How long one library scan may spend reading comics. */
const SCAN_BUDGET_MS = 5 * 60_000;

/**
 * Walks a CBZ, ZIP or EPUB once. With `extractTo` every page is unpacked and checked as an
 * image (the copy import); without it only the entries' names and sizes are checked, and
 * pages are checked as images when they're read (a library folder, read in place).
 *
 * Returns the pages in reading order, as output names (copied) or entry names (in place),
 * plus whatever ComicInfo.xml says.
 */
async function walkArchive(
  file: string,
  kind: ArchiveKind,
  extractTo?: string,
): Promise<{ pages: string[]; info: ComicInfo | null }> {
  const zip = await openZip(file);
  const images: { name: string; output: string }[] = [];
  const seenNames = new Set<string>();
  const documents = new Map<string, string>();
  let documentBytes = 0;
  let info: ComicInfo | null = null;
  let expanded = 0;
  let declaredExpanded = 0;
  let entries = 0;
  let fault: Error | null = null;
  let activeStream: Readable | null = null;
  const archiveError = () => {
    fault = new Error('The comic archive is damaged.');
    activeStream?.destroy(fault);
  };
  zip.on('error', archiveError);
  try {
    for (;;) {
      if (fault) throw fault;
      const entry = await nextEntry(zip);
      if (!entry) break;
      entries += 1;
      if (entries > ENTRY_LIMIT) throw new Error('The archive contains too many entries.');
      checkEntry(entry);
      const name = entry.fileName;
      if (name.endsWith('/')) continue;
      const extension = path.posix.extname(name).toLowerCase();
      const base = path.posix.basename(name).toLowerCase();
      if (!isImageName(name)) {
        if (base === 'comicinfo.xml') {
          info ??= parseComicInfo((await readEntry(zip, entry, COMIC_INFO_LIMIT)).toString('utf8'));
          continue;
        }
        if (kind === 'epub' && EPUB_DOCUMENTS.includes(extension)) {
          const text = (await readEntry(zip, entry, DOCUMENT_LIMIT)).toString('utf8');
          documentBytes += text.length;
          if (documentBytes > DOCUMENTS_TOTAL_LIMIT) throw new Error('The EPUB is too large.');
          documents.set(name, text);
          continue;
        }
        if (kind === 'epub' && (EPUB_SKIPPED.includes(extension) || name === 'mimetype')) continue;
        throw new Error(
          kind === 'epub'
            ? 'This EPUB contains files a comic EPUB should not.'
            : 'Comic archives may contain only JPEG, PNG or WebP pages, ComicInfo.xml and folders.',
        );
      }
      if (images.length >= PAGE_LIMIT) throw new Error('A comic may contain at most 2,000 pages.');
      if (entry.uncompressedSize > IMAGE_LIMIT)
        throw new Error('A page exceeds the 32 MiB page limit.');
      if (!extractTo) {
        // A zip may repeat a name. Read in place, either copy would answer for that page.
        if (!seenNames.has(name)) images.push({ name, output: name });
        seenNames.add(name);
        continue;
      }
      declaredExpanded += entry.uncompressedSize;
      if (declaredExpanded > EXPANDED_LIMIT)
        throw new Error('The archive exceeds the expanded size limit.');
      const output = `${images.length}${extension}`;
      let pageBytes = 0;
      const prefix: Buffer[] = [];
      let prefixLength = 0;
      const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          pageBytes += chunk.length;
          expanded += chunk.length;
          if (pageBytes > IMAGE_LIMIT || expanded > EXPANDED_LIMIT) {
            callback(new Error('The archive exceeds its expanded size limit.'));
            return;
          }
          if (prefixLength < 12) {
            const part = chunk.subarray(0, 12 - prefixLength);
            prefix.push(part);
            prefixLength += part.length;
          }
          callback(null, chunk);
        },
      });
      activeStream = await entryStream(zip, entry);
      if (fault) {
        activeStream.destroy();
        throw fault;
      }
      await pipeline(
        activeStream,
        limiter,
        createWriteStream(path.join(extractTo, output), { flags: 'wx' }),
      );
      activeStream = null;
      if (fault) throw fault;
      if (imageType(Buffer.concat(prefix)) !== expectedType(name))
        throw new Error('A comic page is not a supported image.');
      validateImage(await fs.readFile(path.join(extractTo, output)));
      images.push({ name, output });
    }
    if (images.length === 0) throw new Error('This archive has no image pages.');
    const byName = new Map(images.map((image) => [image.name, image.output]));
    const order =
      kind === 'epub'
        ? epubPageOrder(
            images.map((image) => image.name),
            documents,
          )
        : images.map((image) => image.name).sort(naturalCompare);
    return { pages: order.map((name) => byName.get(name)!), info };
  } finally {
    zip.close();
  }
}

/** The images of a folder (not its sub-folders), in natural order, and its ComicInfo. */
async function folderPages(
  directory: string,
): Promise<{ pages: string[]; info: ComicInfo | null }> {
  const pages: string[] = [];
  let info: ComicInfo | null = null;
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile()) continue; // symbolic links and sub-folders are not pages
    const file = path.join(directory, entry.name);
    if (entry.name.toLowerCase() === 'comicinfo.xml') {
      const status = await fs.lstat(file);
      if (status.isFile() && status.size <= COMIC_INFO_LIMIT)
        info = parseComicInfo(await fs.readFile(file, 'utf8'));
      continue;
    }
    if (!safeSourceName(entry.name)) continue;
    if (pages.length >= PAGE_LIMIT) throw new Error('A comic may contain at most 2,000 pages.');
    pages.push(entry.name);
  }
  if (pages.length === 0) throw new Error('This folder has no JPEG, PNG or WebP pages.');
  return { pages: pages.sort(naturalCompare), info };
}

/** Entries by name for archives being read, so turning a page doesn't walk the zip's whole
 * directory again. Keyed by size and time too: a changed file is a different archive. */
const entryIndexes = new Map<string, Map<string, yauzl.Entry>>();
const ENTRY_INDEXES_KEPT = 4;

async function entryIndex(
  source: ArchiveSource,
  zip: yauzl.ZipFile,
): Promise<Map<string, yauzl.Entry>> {
  const key = `${source.path}\0${source.size}\0${source.mtimeMs}`;
  const known = entryIndexes.get(key);
  if (known) return known;
  const entries = new Map<string, yauzl.Entry>();
  for (;;) {
    const entry = await nextEntry(zip);
    if (!entry) break;
    if (!entries.has(entry.fileName)) entries.set(entry.fileName, entry);
  }
  if (entryIndexes.size >= ENTRY_INDEXES_KEPT) {
    entryIndexes.delete(entryIndexes.keys().next().value!);
  }
  entryIndexes.set(key, entries);
  return entries;
}

/** Reads one page of a comic kept in place, checking the source still is what was found. */
async function readSourcePage(source: ArchiveSource, name: string): Promise<Buffer> {
  if (!safeSourceName(name)) throw new Error('Invalid archive page');
  const status = await fs.stat(source.path);
  if (source.kind === 'zip') {
    if (!status.isFile() || status.size !== source.size || status.mtimeMs !== source.mtimeMs)
      throw new Error('The comic changed on disk. Rescan the library folder.');
    const zip = await openZip(source.path);
    try {
      const entry = (await entryIndex(source, zip)).get(name);
      if (!entry) throw new Error('Invalid archive page');
      checkEntry(entry);
      return await readEntry(zip, entry, IMAGE_LIMIT);
    } finally {
      zip.close();
    }
  }
  if (!status.isDirectory() || name.includes('/')) throw new Error('Invalid archive page');
  const file = path.join(source.path, name);
  const fileStatus = await fs.lstat(file);
  if (!fileStatus.isFile() || fileStatus.isSymbolicLink() || fileStatus.size > IMAGE_LIMIT)
    throw new Error('Invalid archive page');
  if (path.dirname(await fs.realpath(file)) !== (await fs.realpath(source.path)))
    throw new Error('Invalid archive page');
  return await fs.readFile(file);
}

async function removeContainedDirectory(root: string, directory: string): Promise<void> {
  if (path.dirname(path.resolve(directory)) !== path.resolve(root))
    throw new Error('Invalid managed archive directory');
  const status = await fs.lstat(directory);
  if (!status.isDirectory() || status.isSymbolicLink())
    throw new Error('Invalid managed archive directory');
  const resolvedRoot = await fs.realpath(root);
  const resolvedDirectory = await fs.realpath(directory);
  if (path.dirname(resolvedDirectory) !== resolvedRoot)
    throw new Error('Invalid managed archive directory');
  await fs.rm(directory, { recursive: true });
}

async function writeManifest(root: string, directory: string, manifest: ArchiveManifest) {
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest), {
    flag: 'wx',
  });
  requireSameProfile(root);
}

const archiveKind = (file: string): ArchiveKind | null => {
  const extension = path.extname(file).toLowerCase();
  if (extension === '.epub') return 'epub';
  return ARCHIVE_EXTENSIONS.includes(extension) ? 'zip' : null;
};

/* -------------------------------------------------------------- library folders */

const libraryFile = (root: string) => path.join(root, 'library-folders.json');

async function readLibraryFolders(root: string): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(libraryFile(root), 'utf8'));
    return Array.isArray(parsed)
      ? parsed
          .filter((folder): folder is string => typeof folder === 'string')
          .filter((folder) => path.isAbsolute(folder))
          .slice(0, LIBRARY_FOLDER_LIMIT)
      : [];
  } catch {
    return [];
  }
}

async function writeLibraryFolders(root: string, folders: string[]) {
  requireSameProfile(root);
  await fs.writeFile(libraryFile(root), JSON.stringify(folders));
}

type Candidate = { kind: 'zip' | 'epub' | 'folder'; path: string; series?: string };

async function visibleEntries(directory: string) {
  try {
    return (await fs.readdir(directory, { withFileTypes: true })).filter(
      (entry) => !entry.name.startsWith('.') && (entry.isFile() || entry.isDirectory()),
    );
  } catch {
    return [];
  }
}

const hasImages = async (directory: string) =>
  (await visibleEntries(directory)).some((entry) => entry.isFile() && isImageName(entry.name));

/**
 * What a library folder holds, two levels deep: comic archives and folders of pages, in
 * the folder itself or one sub-folder down, where the sub-folder names the series.
 * Symbolic links and hidden entries are not followed.
 */
async function findComics(folder: string): Promise<Candidate[]> {
  const found: Candidate[] = [];
  const consider = async (directory: string, series?: string) => {
    for (const entry of await visibleEntries(directory)) {
      if (found.length >= LIBRARY_ITEM_LIMIT) return;
      const full = path.join(directory, entry.name);
      if (entry.isFile()) {
        const kind = archiveKind(entry.name);
        if (kind) found.push({ kind, path: full, series });
      } else if (await hasImages(full)) {
        found.push({ kind: 'folder', path: full, series });
      } else if (!series) {
        await consider(full, entry.name.slice(0, 200));
      }
    }
  };
  if (await hasImages(folder)) found.push({ kind: 'folder', path: folder });
  await consider(folder);
  return found;
}

/**
 * Brings the comics read in place from `folders` up to date: new or changed ones are
 * indexed (names and sizes only; pages are checked as they're read), ones that are gone
 * are dropped. Never writes to the folders themselves.
 */
async function scanLibrary(
  root: string,
  folders: string[],
  verifyProfile: () => Promise<void>,
): Promise<{ added: number; removed: number; failed: number }> {
  const existing = new Map<string, ArchiveManifest>();
  for (const id of (await fs.readdir(root)).filter((name) => ID_PATTERN.test(name))) {
    try {
      const manifest = await readManifest(root, id);
      if (manifest.source) existing.set(manifest.source.path, manifest);
    } catch {
      /* damaged entries are listed as such and left alone */
    }
  }
  const seen = new Set<string>();
  const unreachable = new Set<string>();
  let added = 0;
  let failed = 0;
  const deadline = Date.now() + SCAN_BUDGET_MS;
  for (const folder of folders) {
    // An unplugged drive or a folder renamed elsewhere: keep what was found there before.
    if (
      !(await fs.stat(folder).then(
        (status) => status.isDirectory(),
        () => false,
      ))
    ) {
      unreachable.add(folder);
      continue;
    }
    for (const candidate of await findComics(folder)) {
      seen.add(candidate.path);
      // A very large folder finishes over several rescans. Whatever wasn't reached keeps
      // what is listed for it, because it is still marked as seen.
      if (Date.now() > deadline) continue;
      try {
        const status = await fs.stat(candidate.path);
        const previous = existing.get(candidate.path);
        // A folder's own modified time changes as pages are added or removed.
        const size = candidate.kind === 'folder' ? 0 : status.size;
        if (
          previous?.source &&
          previous.source.size === size &&
          previous.source.mtimeMs === status.mtimeMs
        )
          continue;
        if (candidate.kind !== 'folder' && status.size > LINKED_ARCHIVE_LIMIT) {
          failed += 1;
          continue;
        }
        const { pages, info } =
          candidate.kind === 'folder'
            ? await folderPages(candidate.path)
            : await walkArchive(candidate.path, candidate.kind);
        const name =
          candidate.kind === 'folder'
            ? path.basename(candidate.path)
            : path.basename(candidate.path, path.extname(candidate.path));
        requireSameProfile(root);
        await verifyProfile();
        // A changed comic keeps its id, so its reading position survives the rescan.
        if (previous) await removeContainedDirectory(root, archiveDirectory(root, previous.id));
        const id = previous?.id ?? randomUUID();
        const directory = archiveDirectory(root, id);
        await fs.mkdir(directory);
        await writeManifest(root, directory, {
          id,
          title: comicDisplayTitle(info, name),
          importedAt: new Date().toISOString(),
          pages,
          ...(info && { info }),
          ...((info?.series ?? candidate.series) && {
            series: (info?.series ?? candidate.series)!.slice(0, 200),
          }),
          source: {
            kind: candidate.kind === 'folder' ? 'folder' : 'zip',
            path: candidate.path,
            size,
            mtimeMs: status.mtimeMs,
          },
          libraryFolder: folder,
        });
        added += 1;
      } catch {
        failed += 1;
      }
    }
  }
  let removed = 0;
  for (const [sourcePath, manifest] of existing) {
    if (unreachable.has(manifest.libraryFolder ?? '')) continue;
    if (seen.has(sourcePath) && folders.includes(manifest.libraryFolder ?? '')) continue;
    requireSameProfile(root);
    await removeContainedDirectory(root, archiveDirectory(root, manifest.id));
    removed += 1;
  }
  return { added, removed, failed };
}

/* ------------------------------------------------------------- opened from outside */

/**
 * Comics handed to the app by the OS ("Open with", a file dropped on the window). Only
 * the main process adds to this; the page can only ask for the next one, so it never
 * names a path itself.
 */
const pendingOpens: string[] = [];
let notifyPending: (() => void) | null = null;

export function queueComicOpen(target: string): void {
  if (!path.isAbsolute(target) || pendingOpens.length >= 10) return;
  pendingOpens.push(target);
  notifyPending?.();
}

/** Called when a comic is queued, so the window can be told to collect it. */
export function onComicOpenQueued(callback: () => void): void {
  notifyPending = callback;
}

/** The comic paths in a command line ("Open with" on Windows and Linux). */
export function comicPathsFromArgs(args: readonly string[]): string[] {
  return args
    .slice(1)
    .filter((arg) => !arg.startsWith('-') && path.isAbsolute(arg) && archiveKind(arg) !== null);
}

let importing = false;
let activePageReads = 0;
export function registerLocalArchiveHandlers(
  requireProfile: (event: IpcMainInvokeEvent) => Promise<() => Promise<void>>,
): void {
  const recoveredProfiles = new Map<string, Promise<void>>();
  const recoverInterruptedImports = async (root: string, verifyProfile: () => Promise<void>) => {
    let recovery = recoveredProfiles.get(root);
    if (!recovery) {
      recovery = (async () => {
        await ensureRoot(root);
        for (const entry of await fs.readdir(root)) {
          if (!entry.startsWith('.partial-') || !ID_PATTERN.test(entry.slice('.partial-'.length)))
            continue;
          requireSameProfile(root);
          await verifyProfile();
          await removeContainedDirectory(root, path.join(root, entry));
        }
      })();
      recoveredProfiles.set(root, recovery);
    }
    try {
      await recovery;
    } catch {
      if (recoveredProfiles.get(root) === recovery) recoveredProfiles.delete(root);
      throw new Error(
        'Interrupted local import cleanup failed. Check local archive storage and retry.',
      );
    }
  };

  /** Copies one comic (archive or folder of pages) into the app, checked page by page. */
  const importPath = async (
    root: string,
    target: string,
    verifyProfile: () => Promise<void>,
  ): Promise<ArchiveSummary> => {
    let temporary: string | undefined;
    try {
      const status = await fs.stat(target);
      const kind = status.isDirectory() ? 'folder' : archiveKind(target);
      if (!kind || (kind !== 'folder' && (!status.isFile() || status.size > COMPRESSED_LIMIT)))
        throw new Error('Choose a CBZ, ZIP or EPUB up to 100 MiB, or a folder of pages.');
      await ensureRoot(root);
      await recoverInterruptedImports(root, verifyProfile);
      const id = randomUUID();
      temporary = path.join(root, `.partial-${id}`);
      await fs.mkdir(temporary);
      let pages: string[];
      let info: ComicInfo | null;
      if (kind === 'folder') {
        const folder = await folderPages(target);
        info = folder.info;
        pages = [];
        let total = 0;
        for (const [index, name] of folder.pages.entries()) {
          const bytes = await readSourcePage(
            { kind: 'folder', path: target, size: 0, mtimeMs: 0 },
            name,
          );
          total += bytes.length;
          if (total > EXPANDED_LIMIT) throw new Error('The folder exceeds the 500 MiB limit.');
          if (validateImage(bytes) !== expectedType(name))
            throw new Error('A comic page is not a supported image.');
          const output = `${index}${path.extname(name).toLowerCase()}`;
          await fs.writeFile(path.join(temporary, output), bytes, { flag: 'wx' });
          pages.push(output);
        }
      } else {
        ({ pages, info } = await walkArchive(target, kind, temporary));
      }
      if (profileDirectory() !== root) throw new Error('The account changed. Please import again.');
      const name =
        kind === 'folder' ? path.basename(target) : path.basename(target, path.extname(target));
      const manifest: ArchiveManifest = {
        id,
        title: comicDisplayTitle(info, name),
        importedAt: new Date().toISOString(),
        pages,
        ...(info && { info }),
        ...(info?.series && { series: info.series }),
      };
      await writeManifest(root, temporary, manifest);
      await verifyProfile();
      await fs.rename(temporary, archiveDirectory(root, id));
      temporary = undefined;
      return summary(manifest);
    } catch (error) {
      if (temporary) {
        try {
          await removeContainedDirectory(root, temporary);
        } catch {
          throw new Error(
            'The import failed and temporary files could not be removed. Close the app before cleaning its local archive storage.',
          );
        }
      }
      if (
        error instanceof Error &&
        !error.message.includes(root) &&
        !error.message.includes(target) &&
        !error.message.includes('ENOENT') &&
        !error.message.includes('EACCES')
      )
        throw error;
      throw new Error('The comic could not be imported. Check file permissions and try again.');
    }
  };

  const exclusive = async <T>(work: () => Promise<T>): Promise<T> => {
    if (importing) throw new Error('Another local import is running.');
    importing = true;
    try {
      return await work();
    } finally {
      importing = false;
    }
  };

  ipcMain.handle('desktop:archives:list', async (event) => {
    const verifyProfile = await requireProfile(event);
    const root = profileDirectory();
    await ensureRoot(root);
    await recoverInterruptedImports(root, verifyProfile);
    const ids = (await fs.readdir(root)).filter((id) => ID_PATTERN.test(id));
    const rows: ArchiveSummary[] = [];
    for (const id of ids) {
      try {
        rows.push(summary(await readManifest(root, id)));
      } catch {
        rows.push({ id, title: 'Damaged local comic', importedAt: '', pageCount: 0 });
      }
    }
    requireSameProfile(root);
    await verifyProfile();
    return rows.sort(
      (a, b) =>
        (a.series ?? '').localeCompare(b.series ?? '') ||
        naturalCompare(a.title, b.title) ||
        b.importedAt.localeCompare(a.importedAt),
    );
  });
  // `kind` only picks the dialog: the path always comes from the OS dialog itself.
  ipcMain.handle('desktop:archives:import', async (event, kind: unknown = 'file') => {
    if (kind !== 'file' && kind !== 'folder') throw new Error('Invalid import kind');
    const verifyProfile = await requireProfile(event);
    return exclusive(async () => {
      const root = profileDirectory();
      const selection = await dialog.showOpenDialog(
        kind === 'folder'
          ? { title: 'Import a folder of comic pages', properties: ['openDirectory'] }
          : {
              title: 'Import a local comic',
              properties: ['openFile'],
              filters: [{ name: 'Comic archives', extensions: ['cbz', 'zip', 'epub'] }],
            },
      );
      if (selection.canceled || !selection.filePaths[0]) return null;
      await verifyProfile();
      if (profileDirectory() !== root) throw new Error('The account changed. Please import again.');
      return importPath(root, selection.filePaths[0], verifyProfile);
    });
  });
  // The next comic the OS handed over (Open with, a drop on the window), copied in.
  ipcMain.handle('desktop:archives:open-pending', async (event) => {
    // Asked on every page load: with nothing queued there is nothing to check yet, which
    // matters at startup, before the account session has settled.
    if (pendingOpens.length === 0) return null;
    const verifyProfile = await requireProfile(event);
    const target = pendingOpens.shift();
    if (!target) return null;
    return exclusive(() => importPath(profileDirectory(), target, verifyProfile));
  });
  // A file or folder dropped on the page. The path comes from Electron's own
  // webUtils.getPathForFile in the preload, for a File the user dropped; it still only
  // reaches the same checked import as the dialog (a comic archive or a folder of pages,
  // copied in), never anything that reads or writes elsewhere.
  ipcMain.handle('desktop:archives:import-dropped', async (event, target: unknown) => {
    if (
      typeof target !== 'string' ||
      target.length === 0 ||
      target.length > 4096 ||
      target.includes('\0') ||
      !path.isAbsolute(target)
    )
      throw new Error('Drop a comic archive or a folder of pages.');
    const verifyProfile = await requireProfile(event);
    return exclusive(() => importPath(profileDirectory(), target, verifyProfile));
  });
  ipcMain.handle('desktop:archives:library-folders', async (event) => {
    const verifyProfile = await requireProfile(event);
    const root = profileDirectory();
    await ensureRoot(root);
    const folders = await readLibraryFolders(root);
    await verifyProfile();
    return folders;
  });
  ipcMain.handle('desktop:archives:add-library-folder', async (event) => {
    const verifyProfile = await requireProfile(event);
    return exclusive(async () => {
      const root = profileDirectory();
      await ensureRoot(root);
      const folders = await readLibraryFolders(root);
      if (folders.length >= LIBRARY_FOLDER_LIMIT)
        throw new Error(`At most ${LIBRARY_FOLDER_LIMIT} library folders.`);
      const selection = await dialog.showOpenDialog({
        title: 'Add a library folder',
        properties: ['openDirectory'],
      });
      if (selection.canceled || !selection.filePaths[0]) return null;
      const folder = await fs.realpath(selection.filePaths[0]);
      if (!(await fs.stat(folder)).isDirectory()) throw new Error('Choose a folder.');
      await verifyProfile();
      requireSameProfile(root);
      const next = folders.includes(folder) ? folders : [...folders, folder];
      await writeLibraryFolders(root, next);
      const result = await scanLibrary(root, next, verifyProfile);
      return { folders: next, ...result };
    });
  });
  ipcMain.handle('desktop:archives:remove-library-folder', async (event, folder: unknown) => {
    const verifyProfile = await requireProfile(event);
    return exclusive(async () => {
      const root = profileDirectory();
      await ensureRoot(root);
      const folders = await readLibraryFolders(root);
      // Only a folder already on the list can be removed; nothing else is touched.
      if (typeof folder !== 'string' || !folders.includes(folder))
        throw new Error('Unknown library folder');
      await verifyProfile();
      const next = folders.filter((existing) => existing !== folder);
      await writeLibraryFolders(root, next);
      const result = await scanLibrary(root, next, verifyProfile);
      return { folders: next, ...result };
    });
  });
  ipcMain.handle('desktop:archives:rescan', async (event) => {
    const verifyProfile = await requireProfile(event);
    return exclusive(async () => {
      const root = profileDirectory();
      await ensureRoot(root);
      const folders = await readLibraryFolders(root);
      return scanLibrary(root, folders, verifyProfile);
    });
  });
  ipcMain.handle('desktop:archives:page', async (event, id: unknown, index: unknown) => {
    if (activePageReads >= 2) throw new Error('Local pages are busy. Please retry.');
    activePageReads += 1;
    try {
      const verifyProfile = await requireProfile(event);
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0)
        throw new Error('Invalid archive page');
      const root = profileDirectory();
      const manifest = await readManifest(root, id);
      const name = manifest.pages[index];
      if (!name) throw new Error('Invalid archive page');
      let bytes: Buffer;
      if (manifest.source) {
        bytes = await readSourcePage(manifest.source, name);
      } else {
        const file = path.join(archiveDirectory(root, id), name);
        const status = await fs.lstat(file);
        if (!status.isFile() || status.isSymbolicLink() || status.size > IMAGE_LIMIT)
          throw new Error('Invalid archive page');
        bytes = await fs.readFile(file);
      }
      const mime = validateImage(bytes);
      if (manifest.source && mime !== expectedType(name)) throw new Error('Invalid archive page');
      if (profileDirectory() !== root) throw new Error('The account changed.');
      await verifyProfile();
      return { bytes: new Uint8Array(bytes), mime };
    } catch {
      throw new Error('The local page could not be loaded.');
    } finally {
      activePageReads -= 1;
    }
  });
  ipcMain.handle('desktop:archives:remove', async (event, id: unknown) => {
    const verifyProfile = await requireProfile(event);
    const root = profileDirectory();
    try {
      await ensureRoot(root);
      requireSameProfile(root);
      await verifyProfile();
      // For a comic read in place this removes only the app's index entry, never the
      // file or folder it points at.
      await removeContainedDirectory(root, archiveDirectory(root, id));
    } catch {
      throw new Error('The local archive could not be removed.');
    }
    return true;
  });
}
