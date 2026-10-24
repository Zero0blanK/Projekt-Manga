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

const COMPRESSED_LIMIT = 100 * 1024 * 1024;
const EXPANDED_LIMIT = 500 * 1024 * 1024;
const IMAGE_LIMIT = 32 * 1024 * 1024;
const PIXEL_LIMIT = 16_000_000;
const DIMENSION_LIMIT = 16_384;
const PAGE_LIMIT = 2000;
const ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const PAGE_PATTERN = /^\d+\.(?:jpg|jpeg|png|webp)$/;
type ArchiveManifest = { id: string; title: string; importedAt: string; pages: string[] };
type ArchiveSummary = Omit<ArchiveManifest, 'pages'> & { pageCount: number };

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
    metadataStatus.size > 256 * 1024
  )
    throw new Error('Invalid local archive');
  const data: unknown = JSON.parse(await fs.readFile(metadata, 'utf8'));
  if (!data || typeof data !== 'object') throw new Error('Invalid local archive');
  const raw = data as Record<string, unknown>;
  if (
    raw.id !== id ||
    typeof raw.title !== 'string' ||
    raw.title.length > 200 ||
    typeof raw.importedAt !== 'string' ||
    !Array.isArray(raw.pages) ||
    raw.pages.length < 1 ||
    raw.pages.length > PAGE_LIMIT ||
    !raw.pages.every((page) => typeof page === 'string' && PAGE_PATTERN.test(page)) ||
    new Set(raw.pages).size !== raw.pages.length
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
  };
}

function openZip(file: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) =>
    yauzl.open(
      file,
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true, autoClose: false },
      (error, zip) =>
        error || !zip
          ? reject(new Error('The selected file is not a readable CBZ archive.'))
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
      reject(new Error('The CBZ archive is damaged.'));
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
      error || !stream ? reject(new Error('The CBZ page could not be read.')) : resolve(stream),
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
  if (!mime) throw new Error('A CBZ page is not a supported image.');
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
    throw new Error('CBZ pages must be at most 16 megapixels and 16,384 pixels per dimension.');
  return mime;
}

async function extractArchive(file: string, temporary: string): Promise<string[]> {
  const zip = await openZip(file);
  const files: { name: string; output: string }[] = [];
  let expanded = 0;
  let declaredExpanded = 0;
  let entries = 0;
  let fault: Error | null = null;
  let activeStream: Readable | null = null;
  const archiveError = () => {
    fault = new Error('The CBZ archive is damaged.');
    activeStream?.destroy(fault);
  };
  zip.on('error', archiveError);
  try {
    for (;;) {
      if (fault) throw fault;
      const entry = await nextEntry(zip);
      if (!entry) break;
      entries += 1;
      if (
        ![entry.uncompressedSize, entry.compressedSize].every(
          (size) => Number.isSafeInteger(size) && size >= 0,
        )
      )
        throw new Error('The CBZ has invalid entry sizes.');
      if (entries > 4000) throw new Error('The CBZ contains too many entries.');
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
      if (name.endsWith('/')) continue;
      const extension = path.posix.extname(name).toLowerCase();
      if (!['.jpg', '.jpeg', '.png', '.webp'].includes(extension))
        throw new Error('CBZ files may contain only JPEG, PNG or WebP pages and directories.');
      if (files.length >= PAGE_LIMIT) throw new Error('A CBZ may contain at most 2,000 pages.');
      declaredExpanded += entry.uncompressedSize;
      if (declaredExpanded > EXPANDED_LIMIT || entry.uncompressedSize > IMAGE_LIMIT)
        throw new Error('The CBZ exceeds the expanded size limit or its 32 MiB page limit.');
      const output = `${files.length}${extension}`;
      let pageBytes = 0;
      const prefix: Buffer[] = [];
      let prefixLength = 0;
      const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          pageBytes += chunk.length;
          expanded += chunk.length;
          if (pageBytes > IMAGE_LIMIT || expanded > EXPANDED_LIMIT) {
            callback(new Error('The CBZ exceeds its expanded size limit.'));
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
        createWriteStream(path.join(temporary, output), { flags: 'wx' }),
      );
      activeStream = null;
      if (fault) throw fault;
      const mime = imageType(Buffer.concat(prefix));
      const expected =
        extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : 'image/jpeg';
      if (mime !== expected) throw new Error('A CBZ page is not a supported image.');
      validateImage(await fs.readFile(path.join(temporary, output)));
      files.push({ name, output });
    }
    if (files.length === 0) throw new Error('This CBZ has no image pages.');
    files.sort(
      (a, b) =>
        a.name.localeCompare(b.name, 'en', { numeric: true }) || a.name.localeCompare(b.name),
    );
    return files.map((file) => file.output);
  } finally {
    zip.close();
  }
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
    return rows.sort((a, b) => b.importedAt.localeCompare(a.importedAt));
  });
  ipcMain.handle('desktop:archives:import', async (event) => {
    const verifyProfile = await requireProfile(event);
    if (importing) throw new Error('Another CBZ import is running.');
    importing = true;
    const root = profileDirectory();
    let temporary: string | undefined;
    try {
      const selection = await dialog.showOpenDialog({
        title: 'Import a local CBZ',
        properties: ['openFile'],
        filters: [{ name: 'Comic book ZIP', extensions: ['cbz'] }],
      });
      if (selection.canceled || !selection.filePaths[0]) return null;
      await verifyProfile();
      if (profileDirectory() !== root) throw new Error('The account changed. Please import again.');
      const file = selection.filePaths[0];
      const status = await fs.stat(file);
      if (
        !status.isFile() ||
        path.extname(file).toLowerCase() !== '.cbz' ||
        status.size > COMPRESSED_LIMIT
      )
        throw new Error('Select a CBZ file no larger than 100 MiB.');
      await ensureRoot(root);
      await recoverInterruptedImports(root, verifyProfile);
      const id = randomUUID();
      temporary = path.join(root, `.partial-${id}`);
      await fs.mkdir(temporary);
      const pages = await extractArchive(file, temporary);
      if (profileDirectory() !== root) throw new Error('The account changed. Please import again.');
      const manifest: ArchiveManifest = {
        id,
        title: path.basename(file, path.extname(file)).slice(0, 200),
        importedAt: new Date().toISOString(),
        pages,
      };
      await fs.writeFile(path.join(temporary, 'manifest.json'), JSON.stringify(manifest), {
        flag: 'wx',
      });
      requireSameProfile(root);
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
        !error.message.includes('ENOENT') &&
        !error.message.includes('EACCES')
      )
        throw error;
      throw new Error('The CBZ could not be imported. Check file permissions and try again.');
    } finally {
      importing = false;
    }
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
      const file = path.join(archiveDirectory(root, id), name);
      const status = await fs.lstat(file);
      if (!status.isFile() || status.isSymbolicLink() || status.size > IMAGE_LIMIT)
        throw new Error('Invalid archive page');
      const bytes = await fs.readFile(file);
      const mime = validateImage(bytes);
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
      await removeContainedDirectory(root, archiveDirectory(root, id));
    } catch {
      throw new Error('The local archive could not be removed.');
    }
    return true;
  });
}
