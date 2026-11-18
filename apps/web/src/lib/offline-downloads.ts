'use client';

import {
  buildDownloadedPageUrl,
  getDownloadedChapterPages,
  getMangaChapters,
  getMangaLinks,
  type DownloadSummary,
} from '@projekt-manga/api-client';
import { desktopBridge } from './desktop-bridge';

/**
 * Downloaded chapters, readable in this browser with no connection.
 *
 * A download lives on the server, so in a browser it could only be read offline if it had
 * been opened here while online. Once the downloads list has loaded, this saves each
 * completed download on the device in the background: its title's page and reader page,
 * the chapter list, and the chapter's pages. Everything goes through the offline worker
 * (public/sw.js) under the same URLs the app asks for later, so offline they are simply
 * there. The desktop app has its downloads on disk already, and has no worker.
 *
 * Takes the device's storage into account: the browser is asked to keep it (not clear it
 * under storage pressure), and nothing more is saved once it is nearly full.
 */

/** Chapters saved (or being saved) during this page load. */
const kept = new Set<string>();
/** Stops saving when this much of the browser's quota for the app is in use. */
const MAX_QUOTA_USE = 0.8;

async function roomLeft(): Promise<boolean> {
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    return quota === 0 || usage / quota < MAX_QUOTA_USE;
  } catch {
    return true;
  }
}

function worker(): Promise<ServiceWorker | null> {
  return navigator.serviceWorker.ready.then((registration) => registration.active);
}

/** Sends `urls` to the worker to keep, under `kind`'s cache, and waits for it to finish. */
function keep(active: ServiceWorker, kind: 'pages' | 'chapters', urls: string[]): Promise<void> {
  if (urls.length === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => resolve();
    active.postMessage({ type: 'keep-urls', kind, urls }, [channel.port2]);
    // A worker replaced mid-way never answers: carry on rather than wait forever.
    setTimeout(resolve, 120_000);
  });
}

export async function keepDownloadsOffline(downloads: DownloadSummary[]): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker || !navigator.onLine) return;
  // The desktop app reads downloads from disk, and has no offline worker.
  if (!Array.isArray(downloads) || desktopBridge()) return;
  const completed = downloads.filter(
    (download) => download.status === 'COMPLETED' && !kept.has(download.chapter_id),
  );
  if (completed.length === 0) return;
  for (const download of completed) kept.add(download.chapter_id);

  const active = await worker();
  if (!active) return;
  void navigator.storage?.persist?.().catch(() => false);

  const titles = new Set<string>();
  // One chapter at a time: this runs behind whatever the reader is doing.
  for (const download of completed) {
    if (!navigator.onLine || !(await roomLeft())) return;
    try {
      const base = window.location.origin;
      if (!titles.has(download.manga_id)) {
        titles.add(download.manga_id);
        const id = encodeURIComponent(download.manga_id);
        await keep(active, 'pages', [
          `${base}/manga/${id}`,
          `${base}/reader/${id}?ch=${download.chapterNumber}&chapterId=${encodeURIComponent(download.chapter_id)}`,
        ]);
        // Asked for as the reader asks, so the worker keeps the answer (network first).
        await getMangaChapters(download.manga_id, download.mangaSlug, download.source_id);
        await getMangaLinks(download.manga_id).catch(() => null);
      }
      const pages = await getDownloadedChapterPages(download.chapter_id);
      await keep(
        active,
        'chapters',
        pages.map(
          (page) => new URL(buildDownloadedPageUrl(download.chapter_id, page.index), base).href,
        ),
      );
    } catch {
      // This one failed (removed meanwhile, or the connection dropped): try it next time.
      kept.delete(download.chapter_id);
    }
  }
}
