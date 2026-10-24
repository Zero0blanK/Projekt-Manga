import type { Source } from '@projekt-manga/types';
import type { download, chapter as Chapter, manga } from '@prisma/client';
import { getInstalledSandboxedSource } from '../services/sandboxedSourceRegistry.service.js';
import downloadService from '../services/download.service.js';
import { recordDiagnosticEvent } from '../utils/diagnosticLog.js';
import { withRequestId } from '../utils/requestContext.js';
import downloadRepository from '../repositories/download.repository.js';
import chapterRepository from '../repositories/chapter.repository.js';
import { NotFoundError, ValidationError, UpstreamError } from '../utils/customErrors.js';
import path from 'path';
import { promises as fsp } from 'fs';
import { EventEmitter } from 'events';

// ─── Types ───────────────────────────────────────────────────────────────────

type DownloadRecord = download & { manga: manga; chapter: Chapter };

interface DownloadProgress {
  downloadId: string;
  currentPage: number;
  totalPages: number;
  pagesDownloaded: number;
}

// ─── Rate Limiter ────────────────────────────────────────────────────────────

/**
 * Spaces outbound source requests by at least `minInterval`, across all concurrent
 * downloads.
 *
 * The slot is reserved synchronously, before any await. Reading the timestamp, awaiting,
 * then writing it back would let concurrent callers compute the same delay and fire
 * together, defeating the spacing.
 */
export class RateLimiter {
  /** When the next request is allowed to go out. Advanced synchronously as each caller
   * claims its slot, so concurrent callers queue behind one another instead of all
   * reading the same value. */
  private nextSlot = 0;
  private minInterval: number;

  constructor(minInterval = 200) {
    this.minInterval = minInterval;
  }

  async wait(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + this.minInterval;

    const delay = slot - now;
    if (delay > 0) {
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  setInterval(interval: number): void {
    this.minInterval = Math.max(100, interval);
  }
}

// ─── Download Worker ─────────────────────────────────────────────────────────

/** Exported for tests only — the app uses the singleton at the bottom of this file, because
 * the queue, the concurrency budget and the retry timers are process-wide state that two
 * instances would each keep their own copy of. */
export class DownloadWorker extends EventEmitter {
  private static readonly PAGE_BATCH_SIZE = 5000;
  private static readonly MAX_QUEUE_SIZE = 100;
  private static readonly MAX_RETRIES = 3;
  private static readonly RETRY_BASE_DELAY_MS = 5_000;
  private static readonly STALL_TIMEOUT_MS = 30 * 60_000; // 30 min
  private static readonly FALLBACK_INTERVAL_MS = 30_000;
  private static readonly PROGRESS_WRITE_INTERVAL_MS = 1_000;
  /** Refuse to start a chapter with less than this much room left. Overridable via
   * DOWNLOAD_MIN_FREE_BYTES. */
  private static readonly DEFAULT_MIN_FREE_BYTES = 500 * 1024 * 1024;

  private queue: string[] = [];
  private pausedDownloads = new Set<string>();
  private activeDownloads = new Map<string, AbortController>();
  private downloadThreads = new Map<string, Promise<void>>();
  private retryCounts = new Map<string, number>();
  /** Last time each download's page counter was persisted — see reportPageProgress. */
  private lastProgressWrite = new Map<string, number>();
  /** Pending backoff timers, so pausing or cancelling can call one off instead of having
   * it re-queue a download the reader has already stopped. */
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private maxConcurrent = 3;
  private rateLimiter = new RateLimiter(200);
  private fallbackTimer: ReturnType<typeof setInterval> | null = null;
  private isShuttingDown = false;
  private lastStatsEvent = 0;

  constructor() {
    super();
    this.rateLimiter = new RateLimiter(200);
    this.registerShutdownHandlers();
    this.startFallbackTimer();
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  addToQueue(downloadId: string): boolean {
    if (this.isShuttingDown) return false;

    this.retryCounts.delete(downloadId);
    this.pausedDownloads.delete(downloadId);

    if (!this.queue.includes(downloadId)) {
      if (this.queue.length >= DownloadWorker.MAX_QUEUE_SIZE) {
        recordDiagnosticEvent({
          level: 'warn',
          area: 'download',
          event: 'download.queue_rejected',
          jobId: downloadId,
          code: 'QUEUE_FULL',
          counts: { capacity: DownloadWorker.MAX_QUEUE_SIZE },
        });
        return false;
      }
      this.queue.push(downloadId);
      recordDiagnosticEvent({
        level: 'info',
        area: 'download',
        event: 'download.queued',
        jobId: downloadId,
        counts: { queueLength: this.queue.length },
      });
    }

    this.processQueue();
    return true;
  }

  async pauseDownload(downloadId: string): Promise<void> {
    this.pausedDownloads.add(downloadId);
    this.clearRetryTimer(downloadId);
    const ctrl = this.activeDownloads.get(downloadId);
    if (ctrl) {
      recordDiagnosticEvent({
        level: 'info',
        area: 'download',
        event: 'download.paused',
        jobId: downloadId,
      });
      ctrl.abort();
      this.activeDownloads.delete(downloadId);
    }
    this.queue = this.queue.filter((id) => id !== downloadId);
  }

  async resumeDownload(downloadId: string): Promise<void> {
    this.pausedDownloads.delete(downloadId);
    this.retryCounts.delete(downloadId);
    if (!this.queue.includes(downloadId) && !this.downloadThreads.has(downloadId)) {
      this.queue.push(downloadId);
    }
    this.processQueue();
  }

  async cancelDownload(downloadId: string): Promise<void> {
    this.pausedDownloads.delete(downloadId);
    this.retryCounts.delete(downloadId);
    this.clearRetryTimer(downloadId);
    const ctrl = this.activeDownloads.get(downloadId);
    if (ctrl) {
      recordDiagnosticEvent({
        level: 'info',
        area: 'download',
        event: 'download.cancelled',
        jobId: downloadId,
      });
      ctrl.abort();
      this.activeDownloads.delete(downloadId);
    }
    this.queue = this.queue.filter((id) => id !== downloadId);
  }

  private clearRetryTimer(downloadId: string): void {
    const timer = this.retryTimers.get(downloadId);
    if (timer) {
      clearTimeout(timer);
      this.retryTimers.delete(downloadId);
    }
  }

  /**
   * Returns downloads left mid-flight by a previous run to the queue.
   *
   * The queue, retry counts and abort controllers live in memory, so after a restart or
   * crash a row left at IN_PROGRESS would otherwise never advance. Called once at startup,
   * after sources are loaded.
   */
  async recoverInterruptedDownloads(): Promise<number> {
    try {
      const stranded = await downloadRepository.getDownloadsByStatus('IN_PROGRESS');
      for (const download of stranded) {
        await downloadRepository.updateDownloadStatus(download.id, 'PENDING');
        this.addToQueue(download.id);
      }
      if (stranded.length > 0) {
        recordDiagnosticEvent({
          level: 'info',
          area: 'download',
          event: 'download.jobs_recovered',
          counts: { recovered: stranded.length },
        });
      }
      return stranded.length;
    } catch {
      // Never fatal to startup: downloads are a background feature, and failing to
      // recover them must not stop the server coming up.
      recordDiagnosticEvent({
        level: 'error',
        area: 'download',
        event: 'download.recovery_failed',
        code: 'RECOVERY_FAILED',
      });
      return 0;
    }
  }

  isPaused(downloadId: string): boolean {
    return this.pausedDownloads.has(downloadId);
  }

  updateRateLimit(requestsPerSecond: number): void {
    this.rateLimiter.setInterval(Math.max(100, 1000 / requestsPerSecond));
    recordDiagnosticEvent({
      level: 'info',
      area: 'download',
      event: 'download.rate_limit_changed',
      counts: { requestsPerSecond },
    });
  }

  setMaxConcurrent(max: number): void {
    this.maxConcurrent = Math.max(1, Math.min(max, 10));
    downloadService.setMaxConcurrentDownloads(this.maxConcurrent);
    recordDiagnosticEvent({
      level: 'info',
      area: 'download',
      event: 'download.concurrency_changed',
      counts: { maxConcurrent: this.maxConcurrent },
    });
  }

  getStatus() {
    return {
      queueLength: this.queue.length,
      activeDownloads: this.activeDownloads.size,
      pausedDownloads: this.pausedDownloads.size,
      maxConcurrent: this.maxConcurrent,
      threadCount: this.downloadThreads.size,
    };
  }

  // ─── Queue Processing ────────────────────────────────────────────────────

  private processQueue(): void {
    if (this.isShuttingDown) return;

    Promise.resolve()
      .then(async () => {
        const available = this.maxConcurrent - this.activeDownloads.size;
        if (available <= 0) return;

        /**
         * Counts *launches*, not loop iterations.
         *
         * Skipped entries must not consume a free slot. `addToQueue` does not filter paused
         * ids, so skippable entries can sit at the head; if skips counted toward the bound,
         * a pass could start nothing, and the only re-entry point (the `finally` of a
         * launched download) would never fire, leaving real work stalled behind them.
         */
        let launched = 0;
        // Entries that are still unwinding from a previous run. Collected rather than pushed
        // back inside the loop: re-queueing mid-loop while the exit condition counts launches
        // would keep handing the same id back to itself, which never terminates.
        const stillFinishing: string[] = [];

        while (launched < available && this.queue.length > 0) {
          const downloadId = this.queue.shift();
          if (!downloadId) break;

          // Dropped outright — a paused download is not waiting for a slot, and resume()
          // re-queues it.
          if (this.pausedDownloads.has(downloadId)) continue;
          if (this.downloadThreads.has(downloadId)) {
            stillFinishing.push(downloadId);
            continue;
          }

          this.launchDownload(downloadId);
          launched++;
        }

        // Back at the front, in their original order: they were ahead of whatever is left in
        // the queue, and a download that is merely finishing should not lose its place.
        if (stillFinishing.length > 0) {
          this.queue.unshift(...stillFinishing);
        }

        this.logStatsIfActive();
      })
      .catch(() =>
        recordDiagnosticEvent({
          level: 'error',
          area: 'download',
          event: 'download.queue_processing_failed',
          code: 'QUEUE_PROCESSING_FAILED',
        }),
      );
  }

  // ─── Download Lifecycle ──────────────────────────────────────────────────

  private launchDownload(downloadId: string): void {
    if (this.pausedDownloads.has(downloadId)) return;
    if (this.downloadThreads.has(downloadId)) return;

    const promise = this.executeDownload(downloadId);
    this.downloadThreads.set(downloadId, promise);

    // Stall guard: abort a download that hangs for >30 min.
    //
    // Deliberately does NOT delete the downloadThreads entry — launchDownload treats that
    // map as "is this id already running", so releasing it here while the promise was
    // still unwinding let a re-queue start a second executeDownload for the same id, with
    // two writers on one file_path. The entry is released in the `finally` below, when
    // the promise has actually settled.
    const stallTimer = setTimeout(() => {
      if (this.downloadThreads.has(downloadId)) {
        recordDiagnosticEvent({
          level: 'error',
          area: 'download',
          event: 'download.stall_timeout',
          jobId: downloadId,
          code: 'STALL_TIMEOUT',
        });
        const ctrl = this.activeDownloads.get(downloadId);
        if (ctrl) {
          ctrl.abort();
          this.activeDownloads.delete(downloadId);
        }
        downloadRepository.updateDownloadStatus(downloadId, 'FAILED').catch((err) => {
          recordDiagnosticEvent({
            level: 'error',
            area: 'download',
            event: 'download.status_persist_failed',
            jobId: downloadId,
            code: 'DATABASE_ERROR',
          });
        });
      }
    }, DownloadWorker.STALL_TIMEOUT_MS);

    promise
      .then(() =>
        recordDiagnosticEvent({
          level: 'info',
          area: 'download',
          event: 'download.completed',
          jobId: downloadId,
        }),
      )
      .catch(() =>
        recordDiagnosticEvent({
          level: 'error',
          area: 'download',
          event: 'download.execution_failed',
          jobId: downloadId,
          code: 'DOWNLOAD_FAILED',
        }),
      )
      .finally(() => {
        clearTimeout(stallTimer);
        this.downloadThreads.delete(downloadId);
        this.lastProgressWrite.delete(downloadId);
        this.processQueue();
      });
  }

  private async executeDownload(downloadId: string): Promise<void> {
    const download = await downloadRepository.getDownloadById(downloadId);
    if (!download) throw new NotFoundError('Download record not found');

    const chapter = await chapterRepository.getChapterWithMangaById(download.chapter_id);
    if (!chapter?.manga) throw new NotFoundError('Chapter or manga not found');

    const sourceId = download.source_id;
    if (!sourceId) throw new ValidationError('Source ID not set');

    // Resolved fresh rather than from a snapshot taken at server boot: an installed
    // extension can be added, updated or removed at any time, and a download queued
    // against one installed five minutes ago must see that change, not a stale reference
    // to a process that may already have been torn down.
    const source = await getInstalledSandboxedSource(sourceId);
    if (!source) throw new NotFoundError(`Source not found: ${sourceId}`);

    const run = () =>
      this.downloadChapterPages(
        downloadId,
        download,
        chapter as DownloadRecord['chapter'] & { manga: manga },
        source,
      );
    if (download.request_id) await withRequestId(download.request_id, run);
    else await run();
  }

  // ─── Core Download Logic ─────────────────────────────────────────────────

  /**
   * Persists how far a download has got, at most once every PROGRESS_WRITE_INTERVAL_MS.
   *
   * Throttled because the counter only drives a progress bar. The last page always writes
   * so the finished state is exact.
   */
  private async reportPageProgress(
    downloadId: string,
    currentPage: number,
    totalPages: number,
  ): Promise<void> {
    const now = Date.now();
    const lastWrite = this.lastProgressWrite.get(downloadId) ?? 0;
    const isLastPage = currentPage >= totalPages;

    if (!isLastPage && now - lastWrite < DownloadWorker.PROGRESS_WRITE_INTERVAL_MS) {
      return;
    }

    this.lastProgressWrite.set(downloadId, now);
    await downloadRepository.updateDownloadProgress(downloadId, { current_page: currentPage });
  }

  /**
   * Refuses to start a chapter when the disk is nearly full.
   *
   * Without this, a full disk surfaces as per-page write failures and retries with partial
   * files left behind. One check before the chapter turns that into a single clear failure.
   *
   * Deliberately not a quota on the library's own size; that is a reader policy decision,
   * whereas "no room left on the device" is a fact worth acting on.
   */
  private async assertDiskSpaceAvailable(): Promise<void> {
    const minFree =
      Number(process.env.DOWNLOAD_MIN_FREE_BYTES) || DownloadWorker.DEFAULT_MIN_FREE_BYTES;
    try {
      const stats = await fsp.statfs(downloadService.getDownloadDir());
      const free = stats.bavail * stats.bsize;
      if (free < minFree) {
        throw new ValidationError(
          `Not enough free disk space to download (${Math.round(free / 1_048_576)}MB available, ${Math.round(minFree / 1_048_576)}MB required)`,
        );
      }
    } catch (error) {
      // A platform or filesystem where statfs isn't supported must not block downloads —
      // only a real shortage should.
      if (error instanceof ValidationError) throw error;
      recordDiagnosticEvent({
        level: 'warn',
        area: 'download',
        event: 'download.disk_space_check_unavailable',
        code: 'FILESYSTEM_UNAVAILABLE',
      });
    }
  }

  private async downloadChapterPages(
    downloadId: string,
    download: DownloadRecord,
    chapter: Chapter & { manga: manga },
    source: Source,
  ): Promise<void> {
    // Before anything is written, so a full disk fails once and clearly rather than as
    // a page-by-page write error with partial files left behind.
    await this.assertDiskSpaceAvailable();

    await downloadRepository.updateDownloadStatus(downloadId, 'IN_PROGRESS');

    const abortController = new AbortController();
    this.activeDownloads.set(downloadId, abortController);

    try {
      // ── Fetch page list from source ──
      await this.rateLimiter.wait();

      const result = await Promise.race([
        source.fetchChapterPages(chapter.id, chapter.manga.slug, {
          limit: DownloadWorker.PAGE_BATCH_SIZE,
          offset: 0,
        }),
        new Promise<never>((_, reject) => {
          abortController.signal.addEventListener('abort', () => reject(new Error('Cancelled')));
        }),
      ]);

      const pages = (result.items || []).filter((p: { image_url?: string }) => !!p?.image_url);
      if (pages.length === 0) throw new UpstreamError('No pages found');

      await downloadRepository.updateDownloadProgress(downloadId, { pages_total: pages.length });
      recordDiagnosticEvent({
        level: 'info',
        area: 'download',
        event: 'download.pages_discovered',
        jobId: downloadId,
        counts: { pages: pages.length },
      });

      // ── Download each page ──
      let successCount = 0;
      let failureCount = 0;

      for (let i = 0; i < pages.length; i++) {
        if (abortController.signal.aborted) throw new Error('Cancelled');

        try {
          await this.reportPageProgress(downloadId, i + 1, pages.length);
          await this.rateLimiter.wait();

          const pageUrl = this.normalizePageUrl(pages[i].image_url, source.base_url, chapter.url);
          if (!pageUrl) throw new UpstreamError(`Invalid URL for page ${i + 1}`);

          await downloadService.downloadPageWithRetry(
            downloadId,
            pageUrl,
            i + 1,
            download.file_path,
            abortController.signal,
            3,
            { headers: this.buildPageRequestHeaders(pageUrl, chapter.url, source.base_url) },
          );

          successCount++;
          await downloadRepository.updateDownloadProgress(downloadId, {
            pages_downloaded: successCount,
          });

          this.emit('progress', {
            downloadId,
            currentPage: i + 1,
            totalPages: pages.length,
            pagesDownloaded: successCount,
          } satisfies DownloadProgress);
        } catch {
          failureCount++;
          if (failureCount > pages.length * 0.5) {
            throw new UpstreamError(`Too many failures (${failureCount}/${pages.length})`);
          }
        }
      }

      if (successCount === 0) throw new UpstreamError('No pages downloaded');

      // ── Finalize ──
      const downloadDir = downloadService.getDownloadDir();
      const downloadedPath = path.join(downloadDir, download.file_path);
      await downloadRepository.updateDownloadProgress(downloadId, {
        downloaded_path: downloadedPath,
      });
      await downloadRepository.updateDownloadStatus(downloadId, 'COMPLETED');

      this.retryCounts.delete(downloadId);

      this.emit('complete', downloadId);
      recordDiagnosticEvent({
        level: failureCount > 0 ? 'warn' : 'info',
        area: 'download',
        event: 'download.pages_finished',
        jobId: downloadId,
        counts: { succeeded: successCount, failed: failureCount, total: pages.length },
      });
    } catch (error) {
      const msg = (error as Error).message;

      if (msg === 'Cancelled') {
        await downloadRepository.updateDownloadStatus(downloadId, 'PENDING').catch(() => {
          recordDiagnosticEvent({
            level: 'error',
            area: 'download',
            event: 'download.status_persist_failed',
            jobId: downloadId,
            code: 'DATABASE_ERROR',
          });
        });
        return;
      }

      if (error instanceof ValidationError && msg.startsWith('Download storage limit reached')) {
        // Keep the partial chapter intact and wait for the reader to free space, then use
        // the existing Resume action. Retrying or cleaning it would waste source requests
        // and discard data simply because the quota did its job.
        this.pausedDownloads.add(downloadId);
        await downloadRepository.updateDownloadStatus(downloadId, 'PENDING').catch(() => {
          recordDiagnosticEvent({
            level: 'error',
            area: 'download',
            event: 'download.status_persist_failed',
            jobId: downloadId,
            code: 'DATABASE_ERROR',
          });
        });
        return;
      }

      recordDiagnosticEvent({
        level: 'error',
        area: 'download',
        event: 'download.attempt_failed',
        jobId: downloadId,
        code:
          error instanceof ValidationError
            ? 'VALIDATION_ERROR'
            : error instanceof UpstreamError
              ? 'UPSTREAM_ERROR'
              : 'DOWNLOAD_FAILED',
      });

      try {
        const filePath = path.join(downloadService.getDownloadDir(), download.file_path);
        await fsp.rm(filePath, { recursive: true, force: true });
      } catch {
        recordDiagnosticEvent({
          level: 'warn',
          area: 'download',
          event: 'download.partial_files_cleanup_failed',
          jobId: downloadId,
          code: 'FILESYSTEM_ERROR',
        });
      }

      // Retry with exponential backoff
      const retries = (this.retryCounts.get(downloadId) ?? 0) + 1;
      this.retryCounts.set(downloadId, retries);

      if (retries <= DownloadWorker.MAX_RETRIES) {
        const delay = DownloadWorker.RETRY_BASE_DELAY_MS * Math.pow(2, retries - 1);
        recordDiagnosticEvent({
          level: 'warn',
          area: 'download',
          event: 'download.retry_scheduled',
          jobId: downloadId,
          counts: { attempt: retries, delayMs: delay },
        });
        // Scheduled rather than awaited: awaiting kept this download's thread alive for
        // the whole backoff (up to 20s at the third attempt), holding one of only
        // maxConcurrent slots while doing nothing at all. Unref'd so a pending retry can
        // never keep the process alive past shutdown.
        const retryTimer = setTimeout(() => {
          this.retryTimers.delete(downloadId);
          if (!this.pausedDownloads.has(downloadId) && !this.isShuttingDown) {
            this.queue.push(downloadId);
            this.processQueue();
          }
        }, delay);
        retryTimer.unref?.();
        this.retryTimers.set(downloadId, retryTimer);
      } else {
        recordDiagnosticEvent({
          level: 'error',
          area: 'download',
          event: 'download.retries_exhausted',
          jobId: downloadId,
          code: 'RETRIES_EXHAUSTED',
          counts: { attempts: retries },
        });
        this.emit('failed', downloadId);
        await downloadRepository.updateDownloadStatus(downloadId, 'FAILED').catch(() => {
          recordDiagnosticEvent({
            level: 'error',
            area: 'download',
            event: 'download.status_persist_failed',
            jobId: downloadId,
            code: 'DATABASE_ERROR',
          });
        });
      }
    } finally {
      this.activeDownloads.delete(downloadId);
    }
  }

  // ─── URL & Headers ───────────────────────────────────────────────────────

  private normalizePageUrl(
    imageUrl?: string,
    baseUrl?: string,
    chapterUrl?: string,
  ): string | null {
    const raw = imageUrl?.trim();
    if (!raw) return null;
    if (raw.startsWith('//')) return `https:${raw}`;
    try {
      return new URL(raw).href;
    } catch {
      /* fall through */
    }

    for (const base of [chapterUrl, baseUrl]) {
      if (!base) continue;
      try {
        return new URL(raw, base).href;
      } catch {
        /* try next */
      }
    }
    return null;
  }

  private buildPageRequestHeaders(
    pageUrl: string,
    chapterUrl?: string,
    sourceBaseUrl?: string,
  ): Record<string, string> {
    const headers: Record<string, string> = {};
    const base = sourceBaseUrl || '';

    for (const candidate of [chapterUrl, sourceBaseUrl]) {
      if (!candidate) continue;
      try {
        headers.Referer = new URL(candidate, base).href;
        break;
      } catch {
        /* try next */
      }
    }
    headers.Referer ||= base;

    try {
      headers.Origin = new URL(base).origin;
    } catch {
      try {
        headers.Origin = new URL(pageUrl).origin;
      } catch {
        /* ignore */
      }
    }
    return headers;
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  private startFallbackTimer(): void {
    // Safety net: periodically drain the queue in case an event is missed
    this.fallbackTimer = setInterval(() => {
      if (this.queue.length > 0 && !this.isShuttingDown) {
        this.processQueue();
      }
    }, DownloadWorker.FALLBACK_INTERVAL_MS);
    this.fallbackTimer.unref?.();
  }

  private registerShutdownHandlers(): void {
    const shutdown = (signal: string) => {
      if (this.isShuttingDown) return;
      this.isShuttingDown = true;
      recordDiagnosticEvent({
        level: 'info',
        area: 'download',
        event: 'download.worker_shutdown',
        code: signal === 'SIGTERM' ? 'SIGTERM' : 'SIGINT',
        counts: { active: this.activeDownloads.size, queued: this.queue.length },
      });

      for (const [id, ctrl] of this.activeDownloads) {
        recordDiagnosticEvent({
          level: 'info',
          area: 'download',
          event: 'download.cancelled_on_shutdown',
          jobId: id,
        });
        ctrl.abort();
      }
      this.activeDownloads.clear();
      this.queue = [];

      if (this.fallbackTimer) {
        clearInterval(this.fallbackTimer);
        this.fallbackTimer = null;
      }

      recordDiagnosticEvent({
        level: 'info',
        area: 'download',
        event: 'download.worker_shutdown_complete',
      });
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }

  private logStatsIfActive(): void {
    const now = Date.now();
    if (now - this.lastStatsEvent < 30_000) return;
    this.lastStatsEvent = now;
    const status = this.getStatus();
    recordDiagnosticEvent({
      level: 'info',
      area: 'download',
      event: 'download.worker_status',
      counts: {
        queueLength: status.queueLength,
        active: status.activeDownloads,
        maxConcurrent: status.maxConcurrent,
      },
    });
  }
}

export default new DownloadWorker();
