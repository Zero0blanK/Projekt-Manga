'use client';

import { useProfilePreference } from '@/lib/profile-preferences';
import { parseReaderOverride, type ReaderPreset } from '@/lib/reader-preferences';

const parseDismissed = (raw: unknown) => raw === true;

/**
 * Shown once per title when its pages look like a webtoon's (far taller than wide) and
 * the reader opened it as a long strip instead of the configured paged layout. "Read page
 * by page" saves this title's reader override with that paged layout — the same per-title
 * setting a preset applies, and the one choice that keeps a webtoon paged. "Got it" is
 * remembered too.
 */
export function WebtoonSuggestion({
  source,
  mangaId,
  visible,
  pagedLayout,
  readingDirection,
  base,
}: {
  source: string;
  mangaId: string;
  visible: boolean;
  /** The paged layout the reader would have used, kept if the reader asks for it. */
  pagedLayout: string;
  readingDirection: string;
  /** The reader's current values, kept in the saved override. */
  base: Omit<ReaderPreset, 'name' | 'pageLayout' | 'readingDirection'>;
}) {
  const [dismissed, setDismissed] = useProfilePreference(
    `webtoon-long-strip-notice-dismissed:${source}:${mangaId}`,
    parseDismissed,
    false,
  );
  const [, setOverride] = useProfilePreference<ReaderPreset | null>(
    `reader-override:${source}:${mangaId}`,
    parseReaderOverride,
    null,
  );
  if (!visible || dismissed) return null;
  return (
    <div
      role="status"
      className="fixed inset-x-0 bottom-20 z-40 mx-auto flex w-fit max-w-[90vw] flex-wrap items-center gap-3 rounded-full border border-white/15 bg-black/85 px-4 py-2 text-sm text-white shadow-lg backdrop-blur"
    >
      <span>This looks like a webtoon, so it opened as one long strip.</span>
      <button
        type="button"
        className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-black"
        onClick={() => setDismissed(true)}
      >
        Got it
      </button>
      <button
        type="button"
        className="rounded-full border border-white/30 px-3 py-1 text-xs"
        onClick={() => {
          setOverride({
            ...base,
            name: 'Page by page',
            pageLayout: pagedLayout,
            readingDirection,
          });
          setDismissed(true);
        }}
      >
        Read page by page
      </button>
    </div>
  );
}
