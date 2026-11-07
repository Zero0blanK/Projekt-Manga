import axios from 'axios';
import fs from 'fs';
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import downloadRepository from '../repositories/download.repository.js';
import chapterRepository from '../repositories/chapter.repository.js';
import mangaRepository from '../repositories/manga.repository.js';
import downloadWorker from '../workers/download.worker.js';
import { createImageRequestHeaders } from '../utils/userAgent.js';
import {
  assertPublicHttpUrl,
  isDisallowedRedirectHost,
  guardedHttpAgent,
  guardedHttpsAgent,
} from '../utils/ssrfGuard.js';
import {
  MangaNotFoundError,
  NotFoundError,
  ValidationError,
  PrismaError,
  ServiceUnavailableError,
  UpstreamError,
  rethrowKnownOrWrap,
} from '../utils/customErrors.js';
import { detectRasterImageType } from '../utils/imageContent.js';
import { fetchSuwayomiImage, isSuwayomiImageUrl, SuwayomiError } from './suwayomi/client.js';
import { DownloadPathPolicy } from '../utils/downloadPathPolicy.js';
import { mapConcurrent } from '../utils/mapConcurrent.js';
import { currentRequestId } from '../utils/requestContext.js';
import {
  listOrphanedDownloadFolders,
  removeOrphanedDownloadFolder,
  type OrphanedDownloadFolder,
} from '../utils/downloadOrphans.js';

/** HTTP status off an axios-shaped rejection, or undefined for anything else (a DNS
 * failure, an abort, a non-axios throw). Replaces an `as any` reach into `.response` —
 * the shape isn't guaranteed, so it's narrowed rather than asserted. */
function responseStatusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('response' in error)) return undefined;
  const { response } = error as { response?: unknown };
  if (typeof response !== 'object' || response === null || !('status' in response))
    return undefined;
  const { status } = response as { status?: unknown };
  return typeof status === 'number' ? status : undefined;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

const pageExtensionByType: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
};
const pageFilename = (page: number, ext: string) => `page_${String(page).padStart(3, '0')}.${ext}`;

/** Strips characters that are invalid in filenames on Windows/POSIX and neutralizes
 * path-separator characters so a crafted title can never add extra path segments
 * (and therefore can't escape the download directory via `..`). */
function sanitizePathSegment(value: string): string {
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

class DownloadService {
  /** A conservative default for a self-hosted reader. It protects storage without ever
   * deleting completed chapters behind the reader's back. */
  private static readonly DEFAULT_DOWNLOAD_STORAGE_BYTES = 10 * 1024 * 1024 * 1024;
  private storageLimitBytes = DownloadService.DEFAULT_DOWNLOAD_STORAGE_BYTES;
  private readonly storageConfigPath: string;
  private static readonly MAX_PAGE_BYTES = 50 * 1024 * 1024;
  private downloadDir: string =
    process.env.DOWNLOAD_DIR || DownloadService.resolveDefaultDownloadDir();
  private storageUsageBytes: number | null = null;
  private storageWriteLock: Promise<void> = Promise.resolve();
  private folderMaintenanceLock: Promise<void> = Promise.resolve();
  private pathPolicy!: DownloadPathPolicy;
  /** A reader asks for a chapter's pages one at a time, and every request needs the sorted
   * list. A finished chapter's folder doesn't change, so it is listed once per reading burst
   * rather than once per page. Short-lived so a folder removed by hand is noticed. */
  private pageListCache = new Map<
    string,
    { downloadPath: string; files: string[]; expiresAt: number }
  >();
  private static readonly PAGE_LIST_TTL_MS = 60_000;
  private static readonly PAGE_LIST_CACHE_SIZE = 64;
  /** Folders checked complete recently, by download id, so listing downloads doesn't re-read
   * every chapter folder on each call. */
  private verifiedFolders = new Map<string, number>();
  private static readonly VERIFIED_FOLDER_TTL_MS = 5 * 60_000;
  private static readonly FOLDER_CHECK_CONCURRENCY = 8;

  private static resolveDefaultDownloadDir(): string {
    return path.join(os.homedir(), 'Downloads', 'ProjektManga');
  }

  constructor() {
    this.ensureDownloadDir();
    const databaseUrl = process.env.DATABASE_URL?.trim() || 'file:./data/projektmanga.db';
    const databaseFile = path.resolve(databaseUrl.slice('file:'.length));
    this.storageConfigPath = path.join(path.dirname(databaseFile), 'download-storage.json');
    if (process.env.NODE_ENV !== 'test') {
      try {
        const saved: unknown = JSON.parse(fs.readFileSync(this.storageConfigPath, 'utf8'));
        if (
          !saved ||
          typeof saved !== 'object' ||
          !('bytes' in saved) ||
          typeof saved.bytes !== 'number' ||
          !Number.isSafeInteger(saved.bytes) ||
          saved.bytes <= 0
        )
          throw new Error('Invalid download storage configuration');
        this.storageLimitBytes = saved.bytes;
      } catch (error) {
        if (!isMissingFile(error))
          console.warn(
            'Download storage configuration could not be loaded; using the default limit. Save a limit in Settings to repair it.',
          );
      }
    }
    this.pathPolicy = new DownloadPathPolicy(
      path.join(path.dirname(databaseFile), 'download-roots.json'),
      [this.downloadDir, DownloadService.resolveDefaultDownloadDir()],
      process.env.NODE_ENV !== 'test',
    );
  }

  private ensureDownloadDir() {
    if (!fs.existsSync(this.downloadDir)) {
      fs.mkdirSync(this.downloadDir, { recursive: true });
    }
  }

  /**
   * Resolves a path that must land inside the active download directory. Throws if it
   * doesn't — the last line of defense against a path-traversal write/read.
   */
  private resolveWithinDownloadDir(...segments: string[]): string {
    const resolved = path.resolve(this.downloadDir, ...segments);
    const root = path.resolve(this.downloadDir) + path.sep;
    if (!resolved.startsWith(root)) {
      throw new ValidationError('Resolved path escapes the download directory');
    }
    return resolved;
  }

  setDownloadDir(dir: string) {
    this.downloadDir = path.resolve(dir);
    this.storageUsageBytes = null;
    this.ensureDownloadDir();
    this.downloadDir = this.pathPolicy.approve(this.downloadDir);
    return this.downloadDir;
  }

  resetDownloadDir() {
    this.downloadDir = process.env.DOWNLOAD_DIR || DownloadService.resolveDefaultDownloadDir();
    this.storageUsageBytes = null;
    this.ensureDownloadDir();
    this.downloadDir = this.pathPolicy.approve(this.downloadDir);
    return this.downloadDir;
  }

  getDownloadDir(): string {
    return this.downloadDir;
  }

  getDownloadStorageLimitBytes(): number {
    return this.storageLimitBytes;
  }

  async setDownloadStorageLimitBytes(bytes: number): Promise<void> {
    if (!Number.isSafeInteger(bytes) || bytes <= 0)
      throw new ValidationError('Storage limit must be a positive integer number of bytes.');
    await this.withStorageWriteLock(async () => {
      if (process.env.NODE_ENV !== 'test') {
        const temporary = `${this.storageConfigPath}.${randomUUID()}.tmp`;
        try {
          await fsp.mkdir(path.dirname(this.storageConfigPath), { recursive: true });
          await fsp.writeFile(temporary, JSON.stringify({ bytes }), { mode: 0o600 });
          await fsp.rename(temporary, this.storageConfigPath);
        } catch {
          throw new ServiceUnavailableError('Could not save the download storage limit.');
        } finally {
          await fsp.rm(temporary, { force: true });
        }
      }
      this.storageLimitBytes = bytes;
    });
  }

  /** A cancellation removes files outside the page writer, so discard the cached total. */
  invalidateDownloadStorageUsage(): void {
    this.storageUsageBytes = null;
  }

  private async getDownloadStorageUsage(): Promise<number> {
    if (this.storageUsageBytes !== null) return this.storageUsageBytes;
    this.storageUsageBytes = await this.getDirectorySize(this.downloadDir);
    return this.storageUsageBytes;
  }

  private async withStorageWriteLock<T>(work: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.storageWriteLock;
    this.storageWriteLock = current;
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  /**
   * Writes under a serialized byte budget. The lock covers the capacity check *and* the
   * write, so concurrent downloads cannot both observe the same remaining space and
   * exceed the cap together.
   */
  private async writeDownloadedPage(
    filePathDir: string,
    pageNumber: number,
    stagedFile: string,
    stagedSize: number,
    extension: string,
  ): Promise<void> {
    await this.withStorageWriteLock(async () => {
      const directory = this.resolveWithinDownloadDir(filePathDir);
      await fsp.mkdir(directory, { recursive: true });
      const pageFile = this.resolveWithinDownloadDir(
        filePathDir,
        pageFilename(pageNumber, extension),
      );
      const priorFiles = await Promise.all(
        Object.values(pageExtensionByType).map(async (ext) => {
          const candidate = this.resolveWithinDownloadDir(
            filePathDir,
            pageFilename(pageNumber, ext),
          );
          try {
            return { candidate, size: (await fsp.stat(candidate)).size };
          } catch (error) {
            if (isMissingFile(error)) return null;
            throw error;
          }
        }),
      );
      const existing = priorFiles.filter((file): file is NonNullable<typeof file> => file !== null);
      const previousSize = existing.reduce((total, file) => total + file.size, 0);
      const usage = await this.getDownloadStorageUsage();
      const nextUsage = usage - previousSize + stagedSize;
      if (nextUsage > this.getDownloadStorageLimitBytes()) {
        throw new ValidationError(
          'Download storage limit reached. Increase the limit in Settings or remove downloads to free space.',
        );
      }
      await fsp.copyFile(stagedFile, `${pageFile}.part`);
      try {
        await fsp.rename(`${pageFile}.part`, pageFile);
      } finally {
        await fsp.rm(`${pageFile}.part`, { force: true });
      }
      for (const file of existing) {
        if (file.candidate !== pageFile) await fsp.rm(file.candidate, { force: true });
      }
      this.storageUsageBytes = nextUsage;
    });
  }

  async initiateDownload(data: {
    sourceId: string;
    mangaSlug: string;
    chapterId: string;
    mangaTitle: string;
    chapterTitle: string;
    chapterNumber: number;
  }) {
    return this.withFolderMaintenanceLock(() => this.initiateDownloadUnlocked(data));
  }

  private async initiateDownloadUnlocked(data: {
    sourceId: string;
    mangaSlug: string;
    chapterId: string;
    mangaTitle: string;
    chapterTitle: string;
    chapterNumber: number;
  }) {
    try {
      if ((await this.getDownloadStorageUsage()) >= this.getDownloadStorageLimitBytes()) {
        throw new ValidationError(
          'Download storage limit reached. Increase the limit in Settings or remove downloads to free space.',
        );
      }
      const manga = await mangaRepository.getMangaBySlug(data.mangaSlug, data.sourceId);

      if (!manga) {
        throw new MangaNotFoundError('Manga not found');
      }

      // `chapterId` is the source's key, as in every chapter a client sends. The title's
      // manga row exists (checked above), so a new or placeholder row gets linked to it,
      // which `download.manga_id` requires.
      const chapter = await chapterRepository.resolveChapter(
        { source: manga.source, manga_slug: manga.slug, source_chapter_key: data.chapterId },
        { name: data.chapterTitle, chapter_number: data.chapterNumber },
      );

      const manga_id = chapter.manga_id ?? manga.id;
      const file_path = this.generateFilePath(
        data.mangaTitle,
        data.chapterNumber,
        data.sourceId,
        data.chapterId,
      );

      const download = await downloadRepository.createDownload({
        manga_id,
        chapter_id: chapter.id,
        source_id: data.sourceId,
        file_path,
        request_id: currentRequestId() ?? null,
      });

      if (!downloadWorker.addToQueue(download.id)) {
        await downloadRepository.deleteDownload(download.id);
        throw new ServiceUnavailableError('Download queue is full; try again later');
      }

      return {
        id: download.id,
        status: 'PENDING',
        progress: 0,
        message: 'Download queued successfully',
      };
    } catch (error) {
      rethrowKnownOrWrap(error, new PrismaError('Failed to initiate download'));
    }
  }

  async getOrphanedDownloadFolders(): Promise<OrphanedDownloadFolder[]> {
    const references = await this.getReferencedDownloadPaths();
    const candidates = await listOrphanedDownloadFolders(
      this.pathPolicy.getApprovedRoots(),
      references,
    );
    return candidates.map(({ absolutePath: _absolutePath, ...candidate }) => candidate);
  }

  async cleanupOrphanedDownloadFolders(
    ids: string[],
  ): Promise<{ removed: number; freedBytes: number }> {
    return this.withFolderMaintenanceLock(async () => {
      const roots = this.pathPolicy.getApprovedRoots();
      const references = await this.getReferencedDownloadPaths();
      const candidates = await listOrphanedDownloadFolders(roots, references);
      const selectedIds = new Set(ids);
      let removed = 0;
      let freedBytes = 0;

      for (const candidate of candidates) {
        if (!selectedIds.has(candidate.id)) continue;
        try {
          await removeOrphanedDownloadFolder(candidate.absolutePath, candidate.id);
          removed += 1;
          freedBytes += candidate.sizeBytes;
        } catch {
          // A concurrently changed, inaccessible, or removed folder is left for a later scan.
        }
      }

      if (removed > 0) this.invalidateDownloadStorageUsage();
      return { removed, freedBytes };
    });
  }

  private async getReferencedDownloadPaths(): Promise<Set<string>> {
    const roots = this.pathPolicy.getApprovedRoots();
    const downloads = await downloadRepository.getAllDownloads();
    const references = new Set<string>();
    for (const download of downloads) {
      const paths = [
        ...(download.downloaded_path ? [download.downloaded_path] : []),
        ...roots.map((root) => path.resolve(root, download.file_path)),
      ];
      paths.forEach((candidate) => references.add(candidate));
    }
    const canonicalPaths = await Promise.all(
      [...references].map((candidate) => fsp.realpath(candidate).catch(() => null)),
    );
    canonicalPaths.forEach((candidate) => {
      if (candidate) references.add(candidate);
    });
    return references;
  }

  private async withFolderMaintenanceLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.folderMaintenanceLock;
    let release!: () => void;
    this.folderMaintenanceLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  /** A page on the connected Suwayomi server, which is reached through its own pinned
   * client rather than the public-address guard. */
  private async downloadSuwayomiPage(
    pageUrl: string,
    pageNumber: number,
    filePathDir: string,
    signal: AbortSignal,
    maxRetries: number,
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (signal.aborted) throw new ValidationError('Download cancelled');
      try {
        const image = await fetchSuwayomiImage(pageUrl, signal);
        const stagedFile = path.join(os.tmpdir(), `projekt-manga-page-${randomUUID()}.part`);
        try {
          await fsp.writeFile(stagedFile, image.bytes, { flag: 'wx' });
          await this.writeDownloadedPage(
            filePathDir,
            pageNumber,
            stagedFile,
            image.bytes.length,
            pageExtensionByType[image.contentType],
          );
        } finally {
          await fsp.rm(stagedFile, { force: true });
        }
        return;
      } catch (error) {
        if (signal.aborted) throw new ValidationError('Download cancelled');
        if (error instanceof ValidationError) throw error;
        lastError = error;
        if (error instanceof SuwayomiError && error.code === 'NOT_FOUND') break;
      }
    }
    throw lastError instanceof Error ? lastError : new UpstreamError('Page download failed');
  }

  async downloadPageWithRetry(
    pageUrl: string,
    pageNumber: number,
    filePathDir: string,
    signal: AbortSignal,
    maxRetries: number = 3,
    requestOptions?: {
      headers?: Record<string, string>;
    },
  ): Promise<void> {
    if (isSuwayomiImageUrl(pageUrl)) {
      return this.downloadSuwayomiPage(pageUrl, pageNumber, filePathDir, signal, maxRetries);
    }
    let lastError: Error | null = null;
    const urlCandidates = this.buildDownloadUrlCandidates(pageUrl);
    const requestHeaders = {
      ...createImageRequestHeaders(undefined, {}, pageUrl),
      ...(requestOptions?.headers || {}),
    };

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (signal.aborted) {
        throw new ValidationError('Download cancelled');
      }

      for (let candidateIndex = 0; candidateIndex < urlCandidates.length; candidateIndex++) {
        const currentUrl = urlCandidates[candidateIndex];

        try {
          await assertPublicHttpUrl(currentUrl);
          const response = await axios.get(currentUrl, {
            responseType: 'stream',
            signal,
            timeout: 30000,
            headers: requestHeaders,
            // Validates the address every hop actually connects to, which beforeRedirect
            // (hostname only) and a pre-flight DNS check (TOCTOU) both miss.
            proxy: false,
            httpAgent: guardedHttpAgent,
            httpsAgent: guardedHttpsAgent,
            beforeRedirect: (options) => {
              if (isDisallowedRedirectHost(String(options.hostname))) {
                throw new Error('Redirect target is disallowed');
              }
            },
          });

          const stagedFile = path.join(os.tmpdir(), `projekt-manga-page-${randomUUID()}.part`);
          let pageBytes = 0;
          let signature = Buffer.alloc(0);
          const limiter = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              pageBytes += chunk.length;
              if (signature.length < 32)
                signature = Buffer.concat([signature, chunk.subarray(0, 32 - signature.length)]);
              callback(
                pageBytes > DownloadService.MAX_PAGE_BYTES
                  ? new ValidationError('Download page exceeds the 50 MB limit')
                  : null,
                chunk,
              );
            },
          });
          try {
            await pipeline(
              response.data as Readable,
              limiter,
              fs.createWriteStream(stagedFile, { flags: 'wx' }),
              { signal },
            );
            const imageType = detectRasterImageType(signature);
            if (!imageType) throw new UpstreamError('The source did not return a valid image');
            await this.writeDownloadedPage(
              filePathDir,
              pageNumber,
              stagedFile,
              pageBytes,
              pageExtensionByType[imageType],
            );
          } finally {
            await fsp.rm(stagedFile, { force: true });
          }

          return;
        } catch (error) {
          lastError = error as Error;

          if (signal.aborted) {
            throw new ValidationError('Download cancelled');
          }
          // A quota rejection is deterministic until files are removed. Retrying the same
          // page three times only wastes source requests and hides the actionable cause.
          if (error instanceof ValidationError) throw error;

          const isNotFound = responseStatusOf(error) === 404;
          const hasFallbackCandidate = candidateIndex < urlCandidates.length - 1;

          if (isNotFound && hasFallbackCandidate) {
            continue;
          }

          break;
        }
      }

      const isRateLimited = responseStatusOf(lastError) === 429;
      const isLastAttempt = attempt === maxRetries;

      if (!isLastAttempt) {
        // Calculate backoff: 5s, 10s, 20s for 429; 1s, 2s, 4s for others
        const multiplier = isRateLimited ? 5 : 1;
        const delayMs = Math.pow(2, attempt) * 1000 * multiplier;

        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    throw new UpstreamError(
      `DOWNLOAD_PAGE_FAILED: Page ${pageNumber} failed after ${maxRetries + 1} attempts.`,
    );
  }

  private buildDownloadUrlCandidates(pageUrl: string): string[] {
    const candidates = [pageUrl];

    // MangaDex's at-home URLs put full-quality pages under /data/ and a compressed
    // fallback under /data-saver/ — some chapters only have the data-saver copy, so this
    // gives a second URL to retry with. A no-op for every other source's URLs.
    if (pageUrl.includes('/data/')) {
      candidates.push(pageUrl.replace('/data/', '/data-saver/'));
    }

    return Array.from(new Set(candidates));
  }

  /**
   * Folder for one downloaded chapter, relative to the download root.
   *
   * Title and number alone were not unique: sources list the same chapter number from
   * different scanlation groups (MangaDex has two "Chapter 82"s for many titles), and two
   * sources can carry the same title, so a second download silently overwrote the first.
   * The source and the chapter's own id make every folder distinct while staying readable.
   * Existing downloads keep the folder recorded in their row.
   */
  private generateFilePath(
    mangaTitle: string,
    chapterNumber: number,
    sourceId: string,
    chapterId: string,
  ): string {
    const title = sanitizePathSegment(`${mangaTitle} [${sourceId}]`).slice(0, 120);
    const release = sanitizePathSegment(chapterId).slice(-24);
    return `${title}/Chapter_${chapterNumber} - ${release}`;
  }

  async pauseDownload(downloadId: string) {
    try {
      const download = await downloadRepository.getDownloadById(downloadId);
      if (!download) {
        throw new NotFoundError('Download not found');
      }

      if (download.status === 'COMPLETED' || download.status === 'FAILED') {
        throw new ValidationError(`Cannot pause download with status ${download.status}`);
      }

      await downloadWorker.pauseDownload(downloadId);
      await downloadRepository.updateDownloadStatus(downloadId, 'PAUSED');
    } catch (error) {
      rethrowKnownOrWrap(error, new PrismaError('Failed to pause download'));
    }
  }

  async resumeDownload(downloadId: string) {
    try {
      const download = await downloadRepository.getDownloadById(downloadId);
      if (!download) {
        throw new NotFoundError('Download not found');
      }

      if (download.status === 'COMPLETED') {
        throw new ValidationError(`Cannot resume download with status ${download.status}`);
      }

      // A failed download's partial files are gone, so it starts over.
      if (download.status === 'FAILED') {
        await downloadRepository.updateDownloadProgress(downloadId, {
          current_page: 0,
          pages_downloaded: 0,
        });
      }

      // Reset to PENDING and re-queue
      if (download.status !== 'PENDING') {
        await downloadRepository.updateDownloadStatus(downloadId, 'PENDING');
      }

      await downloadWorker.resumeDownload(downloadId);
    } catch (error) {
      rethrowKnownOrWrap(error, new PrismaError('Failed to resume download'));
    }
  }

  async cancelDownload(downloadId: string) {
    try {
      await downloadWorker.cancelDownload(downloadId);

      const download = await downloadRepository.getDownloadById(downloadId);
      if (download) {
        // Completed records retain their absolute approved folder, which may belong to
        // a previously selected download root. In-progress rows use the active root.
        const recordedPath = download.downloaded_path
          ? path.isAbsolute(download.downloaded_path)
            ? download.downloaded_path
            : path.resolve(this.downloadDir, download.downloaded_path)
          : this.resolveWithinDownloadDir(download.file_path);
        const safePath = this.pathPolicy.resolveAllowedExistingPath(recordedPath);
        if (safePath) {
          await fsp.rm(safePath, { recursive: true, force: true });
        }

        await downloadRepository.deleteDownload(downloadId);
        this.invalidateDownloadStorageUsage();
        this.pageListCache.delete(download.chapter_id);
        this.verifiedFolders.delete(downloadId);
      }
    } catch (error) {
      rethrowKnownOrWrap(error, new PrismaError('Failed to cancel download'));
    }
  }

  async getDownloadStatus(downloadId: string) {
    try {
      const download = await downloadRepository.getDownloadById(downloadId);
      if (!download) {
        throw new NotFoundError('Download not found');
      }

      return {
        id: download.id,
        status: downloadWorker.isPaused(download.id) ? 'PAUSED' : download.status,
        mangaTitle: download.manga?.title || 'Unknown',
        chapterTitle: download.chapter?.name || `Chapter ${download.chapter?.chapter_number}`,
        filePath: download.file_path,
        completedAt: download.completed_at,
      };
    } catch (error) {
      rethrowKnownOrWrap(error, new PrismaError('Failed to get download status'));
    }
  }

  async getAllDownloads(page?: { limit?: number; offset?: number }) {
    try {
      const downloads = await downloadRepository.getAllDownloads(page);
      return await mapConcurrent(downloads, DownloadService.FOLDER_CHECK_CONCURRENCY, async (d) => {
        const recordedPath = d.downloaded_path
          ? path.isAbsolute(d.downloaded_path)
            ? d.downloaded_path
            : path.resolve(this.downloadDir, d.downloaded_path)
          : path.resolve(this.downloadDir, d.file_path);
        // Do not expose filesystem paths from untrusted/corrupt DB rows to the renderer.
        // The UI can only reveal folders that resolve inside an explicitly approved root.
        let safeDownloadPath = this.pathPolicy.resolveAllowedExistingPath(recordedPath) ?? '';
        if (
          safeDownloadPath &&
          d.status === 'COMPLETED' &&
          !(await this.folderLooksComplete(
            d.id,
            safeDownloadPath,
            Math.max(d.pages_downloaded, d.pages_total),
          ))
        ) {
          safeDownloadPath = '';
        }

        return {
          id: d.id,
          manga_id: d.manga_id,
          chapter_id: d.chapter_id,
          source_chapter_key: d.chapter.source_chapter_key,
          source_id: d.source_id,
          mangaSlug: d.manga.slug,
          status: downloadWorker.isPaused(d.id) ? 'PAUSED' : d.status,
          mangaTitle: d.manga.title,
          chapterTitle: d.chapter.name || `Chapter ${d.chapter.chapter_number}`,
          chapterNumber: d.chapter.chapter_number,
          pages_total: d.pages_total,
          pages_downloaded: d.pages_downloaded,
          current_page: d.current_page,
          filePath: safeDownloadPath,
          downloaded_path: safeDownloadPath,
          createdAt: d.created_at,
          startedAt: d.started_at,
          completedAt: d.completed_at,
        };
      });
    } catch (error) {
      rethrowKnownOrWrap(error, new PrismaError('Failed to get downloads'));
    }
  }

  /** Only a pass is remembered: a folder found incomplete is checked again next time. */
  private async folderLooksComplete(
    downloadId: string,
    directory: string,
    expectedCount: number,
  ): Promise<boolean> {
    const now = Date.now();
    if ((this.verifiedFolders.get(downloadId) ?? 0) > now) return true;
    const complete = await this.hasExpectedDownloadedPages(directory, expectedCount);
    if (complete) {
      this.verifiedFolders.set(downloadId, now + DownloadService.VERIFIED_FOLDER_TTL_MS);
    }
    return complete;
  }

  private async hasExpectedDownloadedPages(
    directory: string,
    expectedCount: number,
  ): Promise<boolean> {
    try {
      const entries = await fsp.readdir(directory, { withFileTypes: true });
      const pageNumbers = new Set<number>();
      for (const entry of entries) {
        const match = /^page_(\d+)\.(?:jpg|png|gif|webp|avif)$/i.exec(entry.name);
        // isFile() is false for a symlink, so nothing counted here can point elsewhere.
        if (!match || !entry.isFile()) continue;
        pageNumbers.add(Number(match[1]));
      }
      if (pageNumbers.size === 0) return false;
      if (!Number.isInteger(expectedCount) || expectedCount <= 0) return true;
      for (let page = 1; page <= expectedCount; page++) {
        if (!pageNumbers.has(page)) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Resolve a completed download's page files, in page order.
   *
   * The directory comes from the download row rather than anything the caller sent, and
   * the filenames come from `readdir` — so no part of the returned path is client-supplied.
   * That's what makes indexing into this list safe to expose over HTTP.
   */
  private async listDownloadedPageFiles(
    chapterId: string,
  ): Promise<{ downloadPath: string; files: string[] }> {
    const cached = this.pageListCache.get(chapterId);
    if (cached && cached.expiresAt > Date.now()) return cached;
    this.pageListCache.delete(chapterId);

    const download = await downloadRepository.getDownloadByChapterId(chapterId);

    if (download?.status !== 'COMPLETED' || !download.downloaded_path) {
      throw new NotFoundError('Chapter not downloaded or path not available');
    }

    const downloadPath = this.pathPolicy.resolveAllowedExistingPath(download.downloaded_path);
    if (!downloadPath) {
      throw new NotFoundError('Downloaded chapter path is outside the configured download folders');
    }

    const entries = await fsp.readdir(downloadPath, { withFileTypes: true }).catch(() => {
      throw new NotFoundError('Downloaded chapter files not found');
    });
    // isFile() is false for a symlink, so a listed page can't point out of the folder.
    const files = entries
      .filter((entry) => entry.isFile() && /^page_\d+\.(?:jpg|png|gif|webp|avif)$/.test(entry.name))
      .map((entry) => entry.name);

    files.sort((a, b) => {
      const aNum = Number.parseInt(a.match(/\d+/)![0], 10);
      const bNum = Number.parseInt(b.match(/\d+/)![0], 10);
      return aNum - bNum;
    });

    if (this.pageListCache.size >= DownloadService.PAGE_LIST_CACHE_SIZE) {
      this.pageListCache.delete(this.pageListCache.keys().next().value!);
    }
    this.pageListCache.set(chapterId, {
      downloadPath,
      files,
      expiresAt: Date.now() + DownloadService.PAGE_LIST_TTL_MS,
    });
    return { downloadPath, files };
  }

  async getDownloadedChapterPages(chapterId: string) {
    try {
      const { files } = await this.listDownloadedPageFiles(chapterId);

      // Indexes only: pages are streamed by index (getDownloadedPageFile), and absolute
      // disk paths would tell any API client the user's folder layout and account name.
      const pages = files.map((_filename, index) => ({ index, retryable: true }));

      return pages;
    } catch (error) {
      rethrowKnownOrWrap(error, new PrismaError('Failed to get downloaded chapter pages'));
    }
  }

  /**
   * Resolve one downloaded page to an absolute file path, for streaming to a reader.
   *
   * `index` is a position in the sorted page list, never a filename — a caller can't name
   * a file to read. The containment check below is belt-and-braces for that: the download
   * directory is user-configurable, so an unexpected `downloaded_path` should fail closed
   * rather than serve something outside it.
   */
  async getDownloadedPageFile(chapterId: string, index: number): Promise<string> {
    try {
      const { downloadPath, files } = await this.listDownloadedPageFiles(chapterId);

      const filename = files[index];
      if (!filename) {
        throw new NotFoundError('Page not found in downloaded chapter');
      }

      return await fsp.realpath(path.resolve(downloadPath, filename)).catch(() => {
        this.pageListCache.delete(chapterId);
        throw new NotFoundError('Page not found in downloaded chapter');
      });
    } catch (error) {
      rethrowKnownOrWrap(error, new PrismaError('Failed to read downloaded page'));
    }
  }

  /**
   * A completed download as CBZ entries, in reading order, plus a file name for it. Built
   * from the same validated page list the reader streams from, so the export can't reach
   * a file the reader couldn't.
   */
  async getDownloadedChapterArchive(
    chapterId: string,
  ): Promise<{ fileName: string; entries: Array<{ name: string; path: string }> }> {
    try {
      const { downloadPath, files } = await this.listDownloadedPageFiles(chapterId);
      if (files.length === 0) throw new NotFoundError('Downloaded chapter has no pages');
      const download = await downloadRepository.getDownloadByChapterId(chapterId);
      const width = Math.max(3, String(files.length).length);
      const entries = await Promise.all(
        files.map(async (filename, index) => ({
          name: `page_${String(index + 1).padStart(width, '0')}${path.extname(filename)}`,
          path: await fsp.realpath(path.resolve(downloadPath, filename)),
        })),
      );
      const title = download?.manga?.title ?? 'Chapter';
      const number = download?.chapter?.chapter_number;
      return {
        fileName: `${title}${number === undefined || number === null ? '' : ` - ch${number}`}.cbz`,
        entries,
      };
    } catch (error) {
      rethrowKnownOrWrap(error, new PrismaError('Failed to read downloaded chapter'));
    }
  }

  async isChapterDownloaded(chapterId: string): Promise<boolean> {
    return await downloadRepository.isChapterDownloaded(chapterId);
  }

  async getDownloadStats() {
    try {
      const downloads = await downloadRepository.getAllDownloads();
      const completed = downloads.filter((d) => d.status === 'COMPLETED');
      const inProgress = downloads.filter((d) => d.status === 'IN_PROGRESS');
      const failed = downloads.filter((d) => d.status === 'FAILED');

      // The running total the storage limit keeps, so this doesn't walk the disk per call.
      const totalSize = await this.getDownloadStorageUsage();

      let freeBytes: number | null = null;
      try {
        const disk = await fsp.statfs(this.downloadDir);
        freeBytes = disk.bavail * disk.bsize;
      } catch {
        // Some filesystems do not expose capacity through statfs; usage stats stay useful.
      }

      return {
        total: downloads.length,
        completed: completed.length,
        inProgress: inProgress.length,
        failed: failed.length,
        totalSize,
        storageLimit: this.getDownloadStorageLimitBytes(),
        freeBytes,
      };
    } catch (error) {
      rethrowKnownOrWrap(error, new PrismaError('Failed to get download stats'));
    }
  }

  /**
   * Recursive directory size, computed asynchronously so a large download library does
   * not block the event loop.
   */
  private async getDirectorySize(dirPath: string): Promise<number> {
    let size = 0;
    let entries;
    try {
      entries = await fsp.readdir(dirPath, { withFileTypes: true });
    } catch (error) {
      if (isMissingFile(error)) return 0;
      throw error;
    }

    for (const entry of entries) {
      const filePath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        size += await this.getDirectorySize(filePath);
      } else {
        try {
          size += (await fsp.stat(filePath)).size;
        } catch (error) {
          if (!isMissingFile(error)) throw error;
        }
      }
    }

    return size;
  }
}

export default new DownloadService();
