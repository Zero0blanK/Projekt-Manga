'use client';

import { useSyncExternalStore } from 'react';
import { useSetting, useNumberSetting } from '@/lib/app-store';
import { useProfilePreference } from '@/lib/profile-preferences';
import { parseReaderOverride, type ReaderPreset } from '@/lib/reader-preferences';

/** Options and defaults for Settings > Reader, shared by the panel and the reader itself
 * so neither side hard-codes a value the other doesn't know about. */

export const PAGE_PREFETCH_OPTIONS = [0, 2, 4, 8, 12] as const;
export const DEFAULT_PAGE_PREFETCH = 4;

export const CHAPTER_PREFETCH_OPTIONS = [1, 2, 3] as const;
export const DEFAULT_CHAPTER_PREFETCH = 1;

export const READER_BACKGROUNDS = [
  { label: 'Black', value: '#000000' },
  { label: 'Charcoal', value: '#111111' },
  { label: 'Grey', value: '#2a2a2a' },
  { label: 'White', value: '#ffffff' },
] as const;
export const DEFAULT_READER_BACKGROUND = 'Black';

/**
 * How far one wheel notch moves the long strip, relative to the browser's own step.
 *
 * 1 is special rather than merely default: at exactly 1 the reader does not intercept the
 * wheel at all, so trackpad momentum, smooth scrolling and any OS accessibility setting
 * on top of them keep working as they do everywhere else. Only a deliberate change is
 * worth overriding those for.
 */
export const SCROLL_SPEED_MIN = 0.5;
export const SCROLL_SPEED_MAX = 3;
export const SCROLL_SPEED_STEP = 0.25;
export const DEFAULT_SCROLL_SPEED = 1;

/** Label values (Slow/Normal/Fast) from when this setting was a three-way choice, so a
 * stored label still resolves instead of coming back NaN. */
const LEGACY_SCROLL_SPEEDS: Record<string, number> = { Slow: 0.5, Normal: 1, Fast: 2 };

export function resolveScrollSpeed(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.min(SCROLL_SPEED_MAX, Math.max(SCROLL_SPEED_MIN, value));
  }
  if (typeof value === 'string') {
    const legacy = LEGACY_SCROLL_SPEEDS[value];
    if (legacy !== undefined) return legacy;
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(SCROLL_SPEED_MAX, Math.max(SCROLL_SPEED_MIN, parsed));
    }
  }
  return DEFAULT_SCROLL_SPEED;
}

/** Shown beside both scroll-speed sliders. `1×` is the browser's own step. */
export function formatScrollSpeed(value: number): string {
  return `${value}×`;
}

/** Hands-free scrolling, in CSS pixels per second at each step of the 1–5 setting. Step 1
 * is slower than comfortable reading; step 5 is about as fast as art stays readable. */
export const AUTO_SCROLL_PIXELS_PER_SECOND = [24, 48, 80, 130, 200] as const;
export const DEFAULT_AUTO_SCROLL_SPEED = 2;

export function autoScrollPixelsPerSecond(speed: number): number {
  const index = Math.min(
    AUTO_SCROLL_PIXELS_PER_SECOND.length - 1,
    Math.max(0, Math.round(speed) - 1),
  );
  return AUTO_SCROLL_PIXELS_PER_SECOND[index];
}

export const DEFAULT_BRIGHTNESS = 100;
export const DEFAULT_STRIP_GAP = 0;

export function readerBackgroundColor(label: string): string {
  return READER_BACKGROUNDS.find((b) => b.label === label)?.value ?? '#000000';
}

export function resolveReadingDirection(globalDirection: string, sourceDirection?: string): string {
  return sourceDirection && sourceDirection !== 'Use default' ? sourceDirection : globalDirection;
}

/** Below this width a two-page spread is not readable. */
const NARROW_READER_QUERY = '(max-width: 767px)';

function subscribeNarrow(callback: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const query = window.matchMedia(NARROW_READER_QUERY);
  query.addEventListener('change', callback);
  return () => query.removeEventListener('change', callback);
}

/** Whether the viewport is phone-width. False during SSR and the first client render. */
export function useNarrowViewport(): boolean {
  return useSyncExternalStore(
    subscribeNarrow,
    () =>
      (typeof window !== 'undefined' && window.matchMedia?.(NARROW_READER_QUERY).matches) || false,
    () => false,
  );
}

/** Everything the reader needs from settings, resolved in one place. */
export function useReaderSettings(sourceId?: string, mangaId?: string) {
  const [override] = useProfilePreference<ReaderPreset | null>(
    `reader-override:${sourceId ?? ''}:${mangaId ?? ''}`,
    parseReaderOverride,
    null,
  );
  const pageLayout = useSetting('pageLayout', 'Two-page spread') as string;
  const defaultDirection = useSetting('readingDirection', 'Right to left') as string;
  const sourceDirection = useSetting(
    sourceId ? `readerDirection:${sourceId}` : 'readingDirection',
    'Use default',
  ) as string;
  const readingDirection = resolveReadingDirection(defaultDirection, sourceDirection);
  const immersiveMode = useSetting('immersiveMode', true) as boolean;
  const preloadNextChapter = useSetting('preloadNextChapter', true) as boolean;
  const showPageNumber = useSetting('showPageNumber', true) as boolean;
  const keepScreenAwake = useSetting('keepScreenAwake', false) as boolean;
  const offsetFirstPage = useSetting('offsetFirstPage', false) as boolean;
  const backgroundLabel = useSetting('readerBackground', DEFAULT_READER_BACKGROUND) as string;

  const pagePrefetchAhead = useNumberSetting('pagePrefetchAhead', DEFAULT_PAGE_PREFETCH);
  const chapterPrefetchCount = useNumberSetting('chapterPrefetchCount', DEFAULT_CHAPTER_PREFETCH);
  const brightness = useNumberSetting('readerBrightness', DEFAULT_BRIGHTNESS);
  const stripGap = useNumberSetting('stripGap', DEFAULT_STRIP_GAP);
  const globalFit = useSetting('zoomBehavior', 'Smart') as string;
  const tapLeft = useSetting('readerTapLeft', 'Direction') as string;
  const tapCenter = useSetting('readerTapCenter', 'Controls') as string;
  const tapRight = useSetting('readerTapRight', 'Opposite') as string;
  const autoAdvance = useSetting('readerAutoAdvance', false) as boolean;
  const hideChromeOnScroll = useSetting('readerHideChromeOnScroll', true) as boolean;
  const scrollSpeedSetting = useSetting('readerScrollSpeed', DEFAULT_SCROLL_SPEED);
  const autoScroll = useSetting('readerAutoScroll', false) as boolean;
  const autoScrollSpeed = useNumberSetting('readerAutoScrollSpeed', DEFAULT_AUTO_SCROLL_SPEED);
  const layout = override?.pageLayout ?? pageLayout;
  const direction = override?.readingDirection ?? readingDirection;
  const narrow = useNarrowViewport();

  return {
    pageLayout: layout,
    readingDirection: direction,
    /** Vertical reading always means the long strip, whatever the page layout says. A
     * two-page spread on a phone-width screen shrinks both pages to unreadable thumbnails,
     * so narrow screens show one page at a time; the saved setting is left as it is for
     * wider screens (it syncs across devices). */
    effectiveLayout:
      direction === 'Vertical (webtoon)'
        ? 'Long strip'
        : narrow && layout === 'Two-page spread'
          ? 'Single page'
          : layout,
    immersiveMode,
    preloadNextChapter,
    showPageNumber,
    keepScreenAwake,
    offsetFirstPage,
    background: readerBackgroundColor(backgroundLabel),
    pagePrefetchAhead: override?.pagePrefetchAhead ?? pagePrefetchAhead,
    chapterPrefetchCount: override?.chapterPrefetchCount ?? chapterPrefetchCount,
    brightness: override?.brightness ?? brightness,
    stripGap: override?.stripGap ?? stripGap,
    zoomBehavior: override?.zoomBehavior ?? globalFit,
    tapActions: { left: tapLeft, center: tapCenter, right: tapRight },
    autoAdvance,
    /** Settings > Reader > Hide controls while scrolling down. On by default: the reader
     * chrome covers the top and bottom of the page, and scrolling down is the one gesture
     * that unambiguously means "I am reading, not navigating". */
    hideChromeOnScroll,
    scrollSpeed: resolveScrollSpeed(scrollSpeedSetting),
    /** Whether hands-free scrolling starts on its own when a chapter opens. The reader's
     * play/pause control is available either way. */
    autoScroll,
    /** The raw 1–N step, for the sliders that set it. */
    autoScrollSpeed,
    autoScrollPixelsPerSecond: autoScrollPixelsPerSecond(autoScrollSpeed),
  };
}
