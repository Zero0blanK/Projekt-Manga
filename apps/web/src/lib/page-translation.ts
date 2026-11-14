/**
 * Reader › Translate page: the translations shown over pages, keyed by each page's own
 * image URL. Japanese only for now. The bubbles are found on the device (lib/page-ocr.ts);
 * the server's manga-ocr reads them when its local translation models are in, else
 * Tesseract does here. The text then goes to the server's translation service: the
 * reader's own, the host's, or the server's own model (English).
 */
import { useSyncExternalStore } from 'react';
import {
  ApiError,
  downloadLocalTranslation,
  getLocalTranslationStatus,
  getTranslateStatus,
  readBubbleTexts,
  readPageRegions,
  translateTexts,
} from '@projekt-manga/api-client';
import type { TranslateTarget } from '@projekt-manga/schemas';
import {
  readPageText,
  readPageTextOnServer,
  readPageTextWith,
  type TextRegion,
} from '@/lib/page-ocr';

export const READER_TRANSLATE_TARGET = 'readerTranslateTarget';

/** The languages offered in Settings, by name (as stored) and the code the server takes. */
export const TRANSLATE_LANGUAGES: ReadonlyArray<readonly [string, TranslateTarget]> = [
  ['English', 'en'],
  ['Spanish', 'es'],
  ['French', 'fr'],
  ['German', 'de'],
  ['Italian', 'it'],
  ['Portuguese', 'pt'],
  ['Indonesian', 'id'],
  ['Russian', 'ru'],
  ['Chinese', 'zh'],
  ['Korean', 'ko'],
];

export const translateTargetFor = (name: string): TranslateTarget =>
  TRANSLATE_LANGUAGES.find(([label]) => label === name)?.[1] ?? 'en';

export type PageTranslation =
  | { status: 'working' }
  | { status: 'error'; message: string }
  | { status: 'done'; regions: TextRegion[]; target: TranslateTarget; shown: boolean };

const pages = new Map<string, PageTranslation>();
const listeners = new Set<() => void>();
const CACHE_LIMIT = 100;

function set(url: string, value: PageTranslation | null) {
  if (value) pages.set(url, value);
  else pages.delete(url);
  if (pages.size > CACHE_LIMIT) pages.delete(pages.keys().next().value!);
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The translation of the page at `url`, if one was asked for. */
export function usePageTranslation(url: string | undefined): PageTranslation | null {
  return useSyncExternalStore(
    subscribe,
    () => (url ? (pages.get(url) ?? null) : null),
    () => null,
  );
}

export function pageTranslation(url: string): PageTranslation | null {
  return pages.get(url) ?? null;
}

let status: Promise<boolean> | null = null;

/** Asks again next time, after the reader saves or removes their own service. */
export function forgetTranslationStatus(): void {
  status = null;
}

/** Whether a translation service is set up for this reader (asked once). */
export function translationAvailable(): Promise<boolean> {
  status ??= getTranslateStatus()
    .then((result) => result.enabled)
    .catch(() => {
      status = null;
      return false;
    });
  return status;
}

/** Once the server's models are in, they stay in: asked again only until then. */
let serverReads = false;
/** Whether the server can also find the text on a page itself (its text detector). */
let serverFindsText = true;

/**
 * The page's Japanese text: read by the server's manga-ocr when its models are in, else by
 * Tesseract here. Models not yet downloaded start downloading (local translation's first
 * use), and this page is read here meanwhile.
 */
async function readPage(url: string): Promise<TextRegion[]> {
  if (!serverReads) {
    const local = await getLocalTranslationStatus().catch(() => null);
    if (local?.enabled && local.state === 'ready') serverReads = true;
    else if (local?.enabled && (local.state === 'missing' || local.state === 'error'))
      void downloadLocalTranslation().catch(() => undefined);
  }
  if (serverReads && serverFindsText) {
    try {
      return await readPageTextOnServer(
        url,
        async (image) => (await readPageRegions({ image })).regions,
      );
    } catch (error) {
      // A server from before it could find the text itself: find the bubbles here.
      if (!(error instanceof ApiError && error.status === 404)) throw error;
      serverFindsText = false;
    }
  }
  if (serverReads) {
    try {
      return await readPageTextWith(
        url,
        async (images) => (await readBubbleTexts({ images })).texts,
      );
    } catch (error) {
      // A server from before local translation: read here, as it used to.
      if (!(error instanceof ApiError && error.status === 404)) throw error;
      serverReads = false;
    }
  }
  return readPageText(url);
}

const messageOf = (error: unknown) =>
  error instanceof Error && error.message ? error.message : "The page couldn't be translated";

/**
 * Reads the page's Japanese text and translates it, or shows a translation already made
 * into the same language.
 */
export async function translatePage(url: string, target: TranslateTarget): Promise<void> {
  const known = pages.get(url);
  if (known?.status === 'working') return;
  if (known?.status === 'done' && known.target === target) {
    set(url, { ...known, shown: true });
    return;
  }
  set(url, { status: 'working' });
  try {
    const regions = await readPage(url);
    if (regions.length === 0) {
      set(url, { status: 'error', message: 'No Japanese text was found on this page' });
      return;
    }
    const { translations } = await translateTexts({
      texts: regions.map((region) => region.text.slice(0, 2000)).slice(0, 60),
      target,
    });
    set(url, {
      status: 'done',
      target,
      shown: true,
      regions: regions
        .slice(0, 60)
        .map((region, index) => ({ ...region, text: translations[index] ?? '' }))
        .filter((region) => region.text.trim()),
    });
  } catch (error) {
    set(url, { status: 'error', message: messageOf(error) });
  }
}

/** Translate all: the chapter's pages, translated one after another. */
export type TranslateAllState =
  | { status: 'idle' }
  | { status: 'running'; done: number; total: number }
  | { status: 'finished'; translated: number; failed: number; total: number };

let allState: TranslateAllState = { status: 'idle' };
let allRun = 0;
const allListeners = new Set<() => void>();

function setAll(state: TranslateAllState) {
  allState = state;
  allListeners.forEach((listener) => listener());
}

export function useTranslateAll(): TranslateAllState {
  return useSyncExternalStore(
    (listener) => {
      allListeners.add(listener);
      return () => allListeners.delete(listener);
    },
    () => allState,
    () => allState,
  );
}

/**
 * Translates every page in `urls`, in order, one at a time (the server reads and translates
 * one page at a time anyway). Pages already translated into `target` are only shown again.
 * A second call replaces a run still going; {@link stopTranslateAll} ends it after the page
 * in hand.
 */
export async function translateAll(urls: readonly string[], target: TranslateTarget) {
  const run = ++allRun;
  const total = urls.length;
  let translated = 0;
  let failed = 0;
  setAll({ status: 'running', done: 0, total });
  for (const [index, url] of urls.entries()) {
    if (run !== allRun) return;
    await translatePage(url, target);
    const result = pages.get(url);
    if (result?.status === 'done') translated++;
    else failed++;
    if (run !== allRun) return;
    setAll({ status: 'running', done: index + 1, total });
  }
  setAll({ status: 'finished', translated, failed, total });
}

export function stopTranslateAll() {
  allRun++;
  setAll({ status: 'idle' });
}

/** Shows the original page again; the translation is kept to switch back to. */
export function showOriginal(url: string) {
  const known = pages.get(url);
  if (known?.status === 'done') set(url, { ...known, shown: false });
  else if (known) set(url, null);
}

/**
 * A font size for `text` filling a `w` × `h` box (fractions of the page), as a fraction
 * of the page's width: as large as fits, roughly, and never larger than half the box.
 */
export function fitFontSize(text: string, w: number, h: number, aspect: number): number {
  const characters = Math.max(1, text.length);
  // The box's area in page-width units (h is a fraction of the page's height).
  const area = w * h * aspect;
  const size = Math.sqrt(area / (characters * 0.62 * 1.2));
  return Math.max(0.008, Math.min(size, w * 0.5, h * aspect * 0.5));
}

/** For tests. */
export function resetPageTranslations() {
  autoQueued.clear();
  pages.clear();
  allRun++;
  allState = { status: 'idle' };
  status = null;
  serverReads = false;
  serverFindsText = true;
  listeners.forEach((listener) => listener());
}

/** Settings › Reader › Page translation › Translate pages automatically. Off unless turned on. */
export const READER_AUTO_TRANSLATE = 'readerAutoTranslate';

let autoQueue: Promise<void> = Promise.resolve();
const autoQueued = new Set<string>();

/**
 * Translates a page that just loaded, when automatic translation is on. One page at a
 * time, however many load at once (a long strip loads several): the server reads one page at
 * a time anyway, and its rate limit would turn the rest away. A page translated before, or
 * one that failed, is left as it is, so "Show original" stays shown and a page with no text
 * isn't tried again and again.
 */
export function autoTranslatePage(url: string, target: TranslateTarget): void {
  if (pages.has(url) || autoQueued.has(url)) return;
  autoQueued.add(url);
  autoQueue = autoQueue
    .then(async () => {
      if (pages.has(url)) return;
      if (!(await translationAvailable())) return;
      await translatePage(url, target);
    })
    .catch(() => undefined)
    .finally(() => autoQueued.delete(url));
}
