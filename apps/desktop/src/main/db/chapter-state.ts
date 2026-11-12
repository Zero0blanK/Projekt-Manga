/**
 * The only writer of the `chapter_state` table, and the home of the rules for how two
 * records of reading progress combine. local-store.ts says which rule a situation calls
 * for; what the rule does to the row is decided here.
 *
 * The server implements the same rules in apps/server/src/utils/readingProgress.ts. Both
 * run the cases in packages/types/fixtures/reading-progress-cases.json
 * (tests/reading-progress.cjs here), so the two cannot drift apart silently.
 */
import type { DatabaseSync } from 'node:sqlite';

export interface ReadingProgress {
  is_read: boolean;
  is_bookmark: boolean;
  last_page_read: number;
}

/** A state as callers hold it: SQLite's 0/1 or a boolean, and any field may be absent. */
export interface ChapterStateInput {
  is_read?: boolean | number | null;
  is_bookmark?: boolean | number | null;
  last_page_read?: number | null;
}

interface StoredState {
  is_read: number;
  is_bookmark: number;
  last_page_read: number;
  updated_at: string;
}

// ─── The rules ───────────────────────────────────────────────────────────────────────

/**
 * Two records that are both true of the same reader: neither is "the newer one", so
 * nothing is discarded. Read and bookmarked if either says so, and the furthest page.
 */
export function foldReadingProgress(
  a: ChapterStateInput | null | undefined,
  b: ChapterStateInput | null | undefined,
): ReadingProgress {
  return {
    is_read: Boolean(a?.is_read) || Boolean(b?.is_read),
    is_bookmark: Boolean(a?.is_bookmark) || Boolean(b?.is_bookmark),
    last_page_read: Math.max(a?.last_page_read ?? 0, b?.last_page_read ?? 0),
  };
}

/**
 * Whether a state pulled from the server replaces the local one. The server has already
 * folded every device's pushes together, so its copy is taken whole (which is also how
 * "marked unread" on another device arrives) unless this device has a newer edit of its
 * own that the next push will send.
 */
export function pulledStateReplaces(localUpdatedAt: string, pulledUpdatedAt: string): boolean {
  return localUpdatedAt <= pulledUpdatedAt;
}

// ─── The table ───────────────────────────────────────────────────────────────────────

function stored(db: DatabaseSync, chapterId: string): StoredState | undefined {
  return db
    .prepare(
      `SELECT is_read, is_bookmark, last_page_read, updated_at FROM chapter_state WHERE chapter_id = ?`,
    )
    .get(chapterId) as StoredState | undefined;
}

function write(db: DatabaseSync, chapterId: string, state: ReadingProgress, at: string): void {
  db.prepare(
    `INSERT INTO chapter_state (chapter_id, is_read, is_bookmark, last_page_read, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(chapter_id) DO UPDATE SET
       is_read = excluded.is_read, is_bookmark = excluded.is_bookmark,
       last_page_read = excluded.last_page_read, updated_at = excluded.updated_at`,
  ).run(chapterId, state.is_read ? 1 : 0, state.is_bookmark ? 1 : 0, state.last_page_read, at);
}

const same = (row: StoredState, state: ReadingProgress): boolean =>
  Boolean(row.is_read) === state.is_read &&
  Boolean(row.is_bookmark) === state.is_bookmark &&
  row.last_page_read === state.last_page_read;

/** First sight of a chapter: adopt the given state, but never over one already stored. */
export function seedChapterState(
  db: DatabaseSync,
  chapterId: string,
  state: ChapterStateInput,
  at: string,
): void {
  if (stored(db, chapterId)) return;
  write(db, chapterId, foldReadingProgress(state, null), at);
}

/**
 * Folds `incoming` into the stored state. With `stamp: 'if-changed'` a fold that changes
 * nothing leaves `updated_at` alone, so a state the server already has is not pushed back
 * as a fresh edit; `'always'` stamps regardless, for rows that must be sent.
 */
export function foldChapterState(
  db: DatabaseSync,
  chapterId: string,
  incoming: ChapterStateInput,
  at: string,
  stamp: 'always' | 'if-changed',
): void {
  const row = stored(db, chapterId);
  const merged = foldReadingProgress(row, incoming);
  if (row && stamp === 'if-changed' && same(row, merged)) return;
  write(db, chapterId, merged, at);
}

/**
 * Folds chapter `fromId`'s state into `intoId`'s. A chapter with no state of its own
 * takes the other's row as it is, `updated_at` included.
 */
export function foldChapterStateInto(
  db: DatabaseSync,
  fromId: string,
  intoId: string,
  at: string,
): void {
  const from = stored(db, fromId);
  if (!from) return;
  if (stored(db, intoId)) {
    foldChapterState(db, intoId, from, at, 'if-changed');
  } else {
    db.prepare(`UPDATE chapter_state SET chapter_id = ? WHERE chapter_id = ?`).run(intoId, fromId);
  }
}

/** The reader marking a chapter read or unread. Unread also forgets the saved page. */
export function setChapterRead(
  db: DatabaseSync,
  chapterId: string,
  isRead: boolean,
  at: string,
): void {
  const row = stored(db, chapterId);
  write(
    db,
    chapterId,
    {
      is_read: isRead,
      is_bookmark: Boolean(row?.is_bookmark),
      last_page_read: isRead ? (row?.last_page_read ?? 0) : 0,
    },
    at,
  );
}

/** The reader turning to a page. A direct edit: paging back moves the saved page back. */
export function setChapterPage(
  db: DatabaseSync,
  chapterId: string,
  lastPageRead: number,
  at: string,
): void {
  const row = stored(db, chapterId);
  write(
    db,
    chapterId,
    {
      is_read: Boolean(row?.is_read),
      is_bookmark: Boolean(row?.is_bookmark),
      last_page_read: lastPageRead,
    },
    at,
  );
}

/** Puts a state on top of whatever is stored: unsent local reading over a restored copy. */
export function overwriteChapterState(
  db: DatabaseSync,
  chapterId: string,
  state: ChapterStateInput,
  at: string,
): void {
  write(db, chapterId, foldReadingProgress(state, null), at);
}

/** A state pulled from the server, taken whole unless a newer local edit is waiting. */
export function adoptPulledChapterState(
  db: DatabaseSync,
  chapterId: string,
  state: ChapterStateInput,
  pulledUpdatedAt: string,
): void {
  const row = stored(db, chapterId);
  if (row && !pulledStateReplaces(row.updated_at, pulledUpdatedAt)) return;
  write(db, chapterId, foldReadingProgress(state, null), pulledUpdatedAt);
}
