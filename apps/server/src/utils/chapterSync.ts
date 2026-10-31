import type { Chapters } from '@projekt-manga/types';

/**
 * Plans how a library title's stored chapters follow the source's current list.
 *
 * Stored chapters are matched to the listing by `source_chapter_key`, the source's own id.
 * Sources derive those from the site's links, so a site that renames a chapter's slug or
 * restructures its URLs hands back the same chapter under a new key. Diffing on the key
 * alone would turn every such chapter into a "new" unread duplicate.
 *
 * Modelled on Mihon's `SyncChaptersWithSource`: a stored chapter the source stopped
 * listing and a listed chapter that was never stored are the same chapter when they agree
 * on number (and scanlator), and are *relinked* — the stored row takes the new key, and
 * everything hanging off it stays — instead of being counted as one removal plus one new
 * chapter.
 *
 * Pure: the repository applies the plan (chapter.repository.ts `applyChapterSync`).
 */

/** The stored columns the plan compares. */
export interface StoredChapter {
  id: string;
  source_chapter_key: string;
  url: string;
  name: string | null;
  scanlator: string | null;
  chapter_number: number;
  release_date: Date | string | null;
}

export interface ChapterMetadataUpdate {
  url?: string;
  name?: string;
  scanlator?: string;
  chapter_number?: number;
  release_date?: Date;
}

export interface ChapterSyncPlan {
  /** Listed chapters with no stored counterpart — the only ones that count as new. */
  added: Chapters[];
  /** A stored chapter (row id `fromId`) the source now lists under a different key. */
  relinked: Array<{ fromId: string; chapter: Chapters }>;
  /** Same key (by stored row id), but the source now reports different metadata for it. */
  updated: Array<{ id: string; data: ChapterMetadataUpdate }>;
  /** Stored row ids the source no longer lists and that matched nothing. Candidates for
   * removal only — the repository keeps any that carry reading state, history or
   * downloads. */
  stale: string[];
  /** True when the plan looked like a broken listing rather than a real change; relinks
   * and removals are then dropped and only additions/metadata updates go ahead. */
  suspicious: boolean;
}

/** Above this share of stored chapters going missing, most of them must be accounted for
 * by relinks — otherwise the list is more likely truncated (a failed second page, a
 * markup change) than restructured, and acting on it would wipe a library title. */
const SUSPICIOUS_STALE_RATIO = 0.5;

/**
 * The number a chapter is matched by, or null when it can't be matched. 0 isn't matched:
 * besides a real chapter 0 it is what sources report for extras and chapters they can't
 * number, and what placeholders hold, so two 0s are as likely different chapters as the
 * same one (and `metadataChanges` already treats 0 as "unknown"). An unmatched chapter
 * is added, and the old row kept while anything hangs off it: a duplicate the reader can
 * see, never progress moved onto the wrong chapter.
 */
function chapterNumberOf(chapter: Pick<Chapters, 'chapter_number'>): number | null {
  const value = Number(chapter.chapter_number);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** Sources disagree on how to say "no group": missing, empty and `Unknown` all mean it. */
function scanlatorKey(scanlator: string | null | undefined): string {
  const value = (scanlator ?? '').trim().toLowerCase();
  return value === 'unknown' ? '' : value;
}

function matchKey(chapterNumber: number, scanlator: string | null | undefined): string {
  return `${chapterNumber}\u0000${scanlatorKey(scanlator)}`;
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Only fields the source actually reports are compared; an empty value never blanks a
 * stored one. Numbers follow the existing renumbering rule: a reported 0 is "unknown",
 * not a correction. */
function metadataChanges(stored: StoredChapter, latest: Chapters): ChapterMetadataUpdate {
  const data: ChapterMetadataUpdate = {};
  if (latest.url && latest.url !== stored.url) data.url = latest.url;
  if (latest.name && latest.name !== (stored.name ?? '')) data.name = latest.name;
  if (latest.scanlator && scanlatorKey(latest.scanlator) !== scanlatorKey(stored.scanlator)) {
    data.scanlator = latest.scanlator;
  }
  const reported = Number(latest.chapter_number);
  if (Number.isFinite(reported) && reported > 0 && reported !== Number(stored.chapter_number)) {
    data.chapter_number = reported;
  }
  const reportedDate = toDate(latest.release_date);
  if (reportedDate && reportedDate.getTime() !== toDate(stored.release_date)?.getTime()) {
    data.release_date = reportedDate;
  }
  return data;
}

export function planChapterSync(stored: StoredChapter[], latest: Chapters[]): ChapterSyncPlan {
  const plan: ChapterSyncPlan = {
    added: [],
    relinked: [],
    updated: [],
    stale: [],
    suspicious: false,
  };

  // An empty list is never a reason to touch stored chapters: it is what a failed parse
  // returns, and what MangaDex's update queue returns for a title already in flight.
  if (latest.length === 0) return plan;

  const unique = new Map<string, Chapters>();
  for (const chapter of latest) {
    if (!unique.has(chapter.id)) unique.set(chapter.id, chapter);
  }
  const storedByKey = new Map(stored.map((chapter) => [chapter.source_chapter_key, chapter]));

  const unseen: Chapters[] = [];
  for (const chapter of unique.values()) {
    const existing = storedByKey.get(chapter.id);
    if (!existing) {
      unseen.push(chapter);
      continue;
    }
    const data = metadataChanges(existing, chapter);
    if (Object.keys(data).length > 0) plan.updated.push({ id: existing.id, data });
  }

  // Stale chapters queued per match key, in stored order, so equal keys pair one-to-one.
  const staleByKey = new Map<string, StoredChapter[]>();
  const staleIds: string[] = [];
  for (const chapter of stored) {
    if (unique.has(chapter.source_chapter_key)) continue;
    staleIds.push(chapter.id);
    const number = chapterNumberOf(chapter);
    if (number === null) continue;
    const key = matchKey(number, chapter.scanlator);
    const queue = staleByKey.get(key);
    if (queue) queue.push(chapter);
    else staleByKey.set(key, [chapter]);
  }

  const relinkedFrom = new Set<string>();
  for (const chapter of unseen) {
    const number = chapterNumberOf(chapter);
    const match =
      number === null ? undefined : staleByKey.get(matchKey(number, chapter.scanlator))?.shift();
    if (match) {
      plan.relinked.push({ fromId: match.id, chapter });
      relinkedFrom.add(match.id);
    } else {
      plan.added.push(chapter);
    }
  }
  plan.stale = staleIds.filter((id) => !relinkedFrom.has(id));

  if (
    stored.length > 0 &&
    staleIds.length > stored.length * SUSPICIOUS_STALE_RATIO &&
    plan.relinked.length < staleIds.length * SUSPICIOUS_STALE_RATIO
  ) {
    // Keep the old rows and add the listed chapters as they are: a duplicate the user can
    // see beats state moved onto the wrong chapter, or a title emptied by a bad scrape.
    plan.added.push(...plan.relinked.map(({ chapter }) => chapter));
    plan.relinked = [];
    plan.stale = [];
    plan.suspicious = true;
  }

  return plan;
}
