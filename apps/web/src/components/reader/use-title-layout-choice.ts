'use client';

import { useCallback } from 'react';
import { useProfilePreference } from '@/lib/profile-preferences';
import { parseReaderOverride, type ReaderPreset } from '@/lib/reader-preferences';

/**
 * The reader header's layout menu changes the global page layout. On a webtoon the reader
 * switched to the long strip automatically, the global layout doesn't show (only a
 * per-title choice does), so picking a paged layout there saves it as this title's reader
 * override — the same choice the notice's "Read page by page" makes — and it takes effect
 * at once and sticks.
 *
 * Returns the menu's `onChooseLayout`: true when it handled the choice, false to let the
 * menu change the global setting as usual (any other title, or "Long strip").
 */
export function useTitleLayoutChoice({
  source,
  mangaId,
  autoLongStrip,
  readingDirection,
  base,
}: {
  source: string;
  mangaId: string;
  /** Whether the long strip on screen was chosen automatically for a webtoon. */
  autoLongStrip: boolean;
  readingDirection: string;
  /** The reader's current values, kept in the saved override. */
  base: Omit<ReaderPreset, 'name' | 'pageLayout' | 'readingDirection'>;
}): (layout: string) => boolean {
  const [, setOverride] = useProfilePreference<ReaderPreset | null>(
    `reader-override:${source}:${mangaId}`,
    parseReaderOverride,
    null,
  );
  return useCallback(
    (layout: string) => {
      if (!autoLongStrip || layout === 'Long strip') return false;
      setOverride({ ...base, name: 'Page by page', pageLayout: layout, readingDirection });
      return true;
    },
    [autoLongStrip, base, readingDirection, setOverride],
  );
}
