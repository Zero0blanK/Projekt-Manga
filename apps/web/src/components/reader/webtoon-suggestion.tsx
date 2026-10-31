'use client';

import { useProfilePreference } from '@/lib/profile-preferences';
import { parseReaderOverride, type ReaderPreset } from '@/lib/reader-preferences';

const parseDismissed = (raw: unknown) => raw === true;

/**
 * Offered once per title when its pages look like a webtoon's (far taller than wide)
 * while it is read page by page: switching saves this title's reader override to the long
 * strip, the same per-title setting a preset applies. "Not now" is remembered too.
 */
export function WebtoonSuggestion({
  source,
  mangaId,
  visible,
  base,
}: {
  source: string;
  mangaId: string;
  visible: boolean;
  /** The reader's current values, kept in the saved override. */
  base: Omit<ReaderPreset, 'name' | 'pageLayout' | 'readingDirection'>;
}) {
  const [dismissed, setDismissed] = useProfilePreference(
    `webtoon-suggestion-dismissed:${source}:${mangaId}`,
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
      <span>This looks like a webtoon. Read it as one long strip?</span>
      <button
        type="button"
        className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-black"
        onClick={() => {
          setOverride({
            ...base,
            name: 'Long strip (webtoon)',
            pageLayout: 'Long strip',
            readingDirection: 'Vertical (webtoon)',
          });
          setDismissed(true);
        }}
      >
        Use long strip
      </button>
      <button
        type="button"
        className="rounded-full border border-white/30 px-3 py-1 text-xs"
        onClick={() => setDismissed(true)}
      >
        Not now
      </button>
    </div>
  );
}
