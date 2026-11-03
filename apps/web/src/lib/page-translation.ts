/**
 * Reader › Translate page: the translations shown over pages, keyed by each page's own
 * image URL. Japanese only for now: the text is read on the device (lib/page-ocr.ts) and
 * only that text goes to the server's translation service.
 */
import { useSyncExternalStore } from 'react';
import { getTranslateStatus, translateTexts } from '@projekt-manga/api-client';
import type { TranslateTarget } from '@projekt-manga/schemas';
import { readPageText, type TextRegion } from '@/lib/page-ocr';

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
    const regions = await readPageText(url);
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
  pages.clear();
  status = null;
  listeners.forEach((listener) => listener());
}
