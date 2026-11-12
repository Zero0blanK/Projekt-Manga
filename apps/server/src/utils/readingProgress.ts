/**
 * How two records of one reader's progress on one chapter combine. Every place that
 * merges read state goes through here (restore, chapter relinks, sync push) so the rule
 * has one home; the desktop cache implements the same rules in
 * apps/desktop/src/main/db/chapter-state.ts, and both run the cases in
 * packages/types/fixtures/reading-progress-cases.json.
 */

export interface ReadingProgress {
  is_read: boolean;
  is_bookmark: boolean;
  last_page_read: number;
}

/** What a stored or incoming row may leave out: a missing field counts as "nothing". */
type PartialProgress = {
  is_read?: boolean | null;
  is_bookmark?: boolean | null;
  last_page_read?: number | null;
};

/**
 * Two records that are both true of the same reader: neither is "the newer one", so
 * nothing is discarded. Read and bookmarked if either says so, and the furthest page.
 */
export function foldReadingProgress(
  a: PartialProgress | null | undefined,
  b: PartialProgress | null | undefined,
): ReadingProgress {
  return {
    is_read: Boolean(a?.is_read) || Boolean(b?.is_read),
    is_bookmark: Boolean(a?.is_bookmark) || Boolean(b?.is_bookmark),
    last_page_read: Math.max(a?.last_page_read ?? 0, b?.last_page_read ?? 0),
  };
}

/**
 * A device's pushed state against the stored one. Read and the page only ever advance,
 * whichever side is newer, so an offline device reconnecting days later cannot drag
 * progress back. The bookmark is a toggle with no sane union, so the newer edit wins and
 * the stored one keeps a tie.
 */
export function mergePushedReadingProgress(
  existing: ReadingProgress & { updated_at: Date },
  incoming: ReadingProgress & { updated_at: Date },
): ReadingProgress {
  const storedWins = existing.updated_at >= incoming.updated_at;
  return {
    ...foldReadingProgress(existing, incoming),
    is_bookmark: storedWins ? existing.is_bookmark : incoming.is_bookmark,
  };
}
