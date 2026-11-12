/**
 * Local-first data operations against the SQLite DB (connection.ts). This is the
 * implementation behind the `desktop:data:invoke` IPC channel (see ../ipc.ts) — every
 * function here is synchronous (node:sqlite's DatabaseSync API), matching the
 * request/response shape IPC calls need.
 *
 * Covers the manga/chapter catalog cache, per-chapter read state, per-manga library/shelf
 * state, and history — enough to browse the library, mark chapters read, and survive a
 * restart with no server running.
 */
import { getDb } from './connection';
import {
  adoptPulledChapterState,
  foldChapterState,
  foldChapterStateInto,
  overwriteChapterState,
  seedChapterState,
  setChapterPage,
  setChapterRead,
} from './chapter-state';
import { createId } from '@paralleldrive/cuid2';
import { getCachedSession, type CachedSession } from '../auth-cache';
import { SESSION_COOKIE_NAME } from '../../shared/config';
import { requireSecureAccountTransport } from '../secure-transport';

function nowIso(): string {
  return new Date().toISOString();
}

// ─── Types (mirroring packages/api-client's shapes closely enough to seed from/serve
// them without a translation layer at the IPC boundary) ───────────────────────────────

export interface LocalMangaInput {
  id: string;
  slug: string;
  title: string;
  author?: string | null;
  source?: string | null;
  thumbnail_url?: string | null;
  artist?: string | null;
  description?: string | null;
  genres?: string | null;
  status?: string | null;
}

/** How the renderer, sync and the server name a chapter: the source's own id for it,
 * within its title. Row ids are each database's own — this one's match the server's for
 * chapters that came from it, and are minted here for chapters read before that. */
export interface LocalChapterRef {
  source: string;
  manga_slug: string;
  source_chapter_key: string;
}

export interface LocalChapterInput extends LocalChapterRef {
  id: string;
  manga_id: string;
  url?: string | null;
  name?: string | null;
  scanlator?: string | null;
  chapter_number: number;
  release_date?: string | null;
  page_count?: number | null;
  is_read?: boolean;
  is_bookmark?: boolean;
  last_page_read?: number;
}

export interface LocalHistoryInput {
  /** Optional — generated locally via cuid2 (format-compatible with the server's Prisma
   * cuid() ids) when omitted, e.g. for a fresh local write. The seed step passes the
   * server's own id explicitly instead, so a later sync recognizes it as
   * the same row rather than creating a duplicate. */
  id?: string;
  source: string;
  manga_id?: string | null;
  manga_slug: string;
  source_manga_id?: string | null;
  title?: string | null;
  thumbnail_url?: string | null;
  /** The source's id for the chapter, within `source` + `manga_slug`. */
  source_chapter_key?: string | null;
  pages_read?: number;
  time_read?: number;
}

// ─── Manga + chapter catalog cache (write side, used by the seed step and by "add to
// library" while online) ───────────────────────────────────────────────────────────────

/** How a catalog write treats library membership. `ifMissing` (the default) only gives a
 * title with no local state a library row — a catalog refresh or seed must not resurrect a
 * title the user removed here, nor bump `updated_at` so the row re-pushes. `add` is for the
 * caller that is explicitly adding the title to the library. */
type LibraryMembership = 'add' | 'ifMissing';

/**
 * `updated_at` for state copied down from the server. Pending changes are the rows edited
 * since the last push, so stamping these "now" would send what the server just said straight
 * back as new edits. Older than any cursor, they count as already pushed, and a real local
 * edit stamps its own time.
 */
const FROM_SERVER = '1970-01-01T00:00:00.000Z';

function upsertManga(input: LocalMangaInput, membership: LibraryMembership = 'ifMissing'): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO manga (id, slug, title, author, source, thumbnail_url, artist, description, genres, status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       slug=excluded.slug, title=excluded.title, author=excluded.author, source=excluded.source,
       thumbnail_url=excluded.thumbnail_url, artist=excluded.artist, description=excluded.description,
       genres=excluded.genres, status=excluded.status, updated_at=excluded.updated_at`,
  ).run(
    input.id,
    input.slug,
    input.title,
    input.author ?? null,
    input.source ?? null,
    input.thumbnail_url ?? null,
    input.artist ?? null,
    input.description ?? null,
    input.genres ?? null,
    input.status ?? null,
    nowIso(),
  );

  if (membership === 'add') {
    db.prepare(
      `INSERT INTO manga_state (manga_id, in_library, updated_at) VALUES (?, 1, ?)
       ON CONFLICT(manga_id) DO UPDATE SET in_library = 1,
         updated_at = CASE WHEN manga_state.in_library = 1 THEN manga_state.updated_at ELSE excluded.updated_at END`,
    ).run(input.id, nowIso());
    return;
  }
  db.prepare(
    `INSERT INTO manga_state (manga_id, in_library, updated_at) VALUES (?, 1, ?)
     ON CONFLICT(manga_id) DO NOTHING`,
  ).run(input.id, FROM_SERVER);
}

/**
 * Writes a chapter the server sent, under the server's row id.
 *
 * A row this device stood up for the same key before the server's arrived (a read from a
 * source, or a pulled state for a title not synced yet) is the same chapter: it is folded
 * into the server's row, so its state and history follow and nothing is duplicated. A
 * server relink arrives as a new key on an id this device already has, and just updates it.
 */
function upsertChapter(input: LocalChapterInput): void {
  const db = getDb();
  const stub = db
    .prepare(
      `SELECT id FROM chapter WHERE source = ? AND manga_slug = ? AND source_chapter_key = ? AND id <> ?`,
    )
    .get(input.source, input.manga_slug, input.source_chapter_key, input.id) as
    { id: string } | undefined;
  if (stub) {
    // Frees the key for the server's row; the stub is folded in and deleted below.
    db.prepare(
      `UPDATE chapter SET source_chapter_key = source_chapter_key || char(0) || id WHERE id = ?`,
    ).run(stub.id);
  }

  db.prepare(
    `INSERT INTO chapter (id, source, manga_slug, source_chapter_key, manga_id, url, name, scanlator, chapter_number, release_date, page_count, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       source=excluded.source, manga_slug=excluded.manga_slug,
       source_chapter_key=excluded.source_chapter_key,
       manga_id=excluded.manga_id, url=excluded.url, name=excluded.name, scanlator=excluded.scanlator,
       chapter_number=excluded.chapter_number, release_date=excluded.release_date,
       page_count=excluded.page_count, updated_at=excluded.updated_at`,
  ).run(
    input.id,
    input.source,
    input.manga_slug,
    input.source_chapter_key,
    input.manga_id,
    input.url ?? null,
    input.name ?? null,
    input.scanlator ?? null,
    input.chapter_number,
    input.release_date ?? null,
    input.page_count ?? null,
    nowIso(),
  );

  // Read state is only ever written by seedChapterState (first sight, "adopt whatever
  // the server said") or the local mark-read/progress calls below — a catalog re-upsert
  // must never clobber it, so this only creates the row if it doesn't exist yet.
  seedChapterState(db, input.id, input, FROM_SERVER);

  if (stub) mergeChapterInto(stub.id, input.id);
}

/**
 * Folds chapter row `fromId` into `intoId` and deletes it. State merges as the server's
 * does — read/bookmark as "either", progress as the furthest — and is stamped only when
 * the merge changes something, so a state the server already has is not pushed back as a
 * fresh edit, while a local edit it lacks is. History follows the chapter.
 */
function mergeChapterInto(fromId: string, intoId: string): void {
  const db = getDb();
  foldChapterStateInto(db, fromId, intoId, nowIso());
  // One live history row per chapter: a row the other chapter already has takes this
  // one's reading, and this one becomes a tombstone (as deleteHistory leaves it, with
  // last_read bumped so the next push carries it) for the server and other devices.
  const kept = db
    .prepare(`SELECT id FROM history WHERE chapter_id = ? AND deleted_at IS NULL LIMIT 1`)
    .get(intoId) as { id: string } | undefined;
  if (kept) {
    const folded = db
      .prepare(`SELECT * FROM history WHERE chapter_id = ? AND deleted_at IS NULL`)
      .all(fromId) as Array<{
      id: string;
      read_at: string;
      last_read: string;
      pages_read: number;
      time_read: number;
    }>;
    const now = nowIso();
    for (const row of folded) {
      db.prepare(
        `UPDATE history SET
           read_at = MIN(read_at, ?), last_read = MAX(last_read, ?),
           pages_read = MAX(pages_read, ?), time_read = time_read + ?
         WHERE id = ?`,
      ).run(row.read_at, row.last_read, row.pages_read, row.time_read, kept.id);
      db.prepare(`UPDATE history SET deleted_at = ?, last_read = ? WHERE id = ?`).run(
        now,
        now,
        row.id,
      );
    }
  }
  db.prepare(`UPDATE history SET chapter_id = ? WHERE chapter_id = ?`).run(intoId, fromId);
  db.prepare(`DELETE FROM chapter WHERE id = ?`).run(fromId);
}

// ─── Reads ─────────────────────────────────────────────────────────────────────────────

export interface LocalMangaListItem {
  id: string;
  slug: string;
  title: string;
  // Non-null to match api-client's Manga, which mirrors the server's own columns (all
  // three are NOT NULL there). The local table allows null because a partially-seeded row
  // can lack them; the coercion happens at this boundary rather than being pushed onto
  // the renderer, which cannot tell which transport answered.
  author: string;
  source: string;
  thumbnail_url: string;
  in_library: boolean;
  chapter_count: number;
  unread_count: number;
  /** Not tracked locally (no per-chapter fetch timestamp cached yet) — always null.
   * Matches packages/api-client's MangaListItem shape so callers don't need a
   * local-specific type. */
  latest_chapter_date: string | null;
  /**
   * Mirrors MangaListItem.manga_detail. The web app reads status, genres, description,
   * artist and rating *only* from here (see manga-data.ts's `fromMangaListItem`), so
   * omitting it made every card in the desktop build fall back to its defaults — most
   * visibly a status pill reading "Unknown" on every title, while the same card was
   * correct in a browser because that path goes over HTTP to the server instead.
   */
  manga_detail: {
    status: string;
    genres: string;
    description: string;
    artist: string | null;
    rating: number | null;
  };
  created_at: string;
  updated_at: string;
}

function listLibrary(): LocalMangaListItem[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT m.id, m.slug, m.title, m.author, m.source, m.thumbnail_url, m.updated_at,
              m.artist, m.description, m.genres, m.status,
              COUNT(c.id) AS chapter_count,
              -- The c.id IS NOT NULL guard covers the LEFT JOIN's placeholder row: a
              -- manga with no chapters still produces one all-null row here, and without
              -- it the NULL is_read counted as an unread chapter, so every title not yet
              -- fetched wore a phantom "1 unread" badge.
              SUM(CASE WHEN c.id IS NOT NULL AND (cs.is_read = 0 OR cs.is_read IS NULL) THEN 1 ELSE 0 END) AS unread_count
       FROM manga m
       JOIN manga_state ms ON ms.manga_id = m.id AND ms.in_library = 1
       LEFT JOIN chapter c ON c.manga_id = m.id
       LEFT JOIN chapter_state cs ON cs.chapter_id = c.id
       GROUP BY m.id
       ORDER BY m.title ASC`,
    )
    .all();

  return rows.map((r) => ({
    id: r.id as string,
    slug: r.slug as string,
    title: r.title as string,
    author: (r.author as string | null) ?? '',
    source: (r.source as string | null) ?? '',
    thumbnail_url: (r.thumbnail_url as string | null) ?? '',
    in_library: true,
    chapter_count: r.chapter_count as number,
    unread_count: (r.unread_count as number) ?? 0,
    latest_chapter_date: null,
    manga_detail: {
      // 'UNKNOWN' rather than '' — it's the key STATUS_MAP looks up for "no status", so
      // an empty string would miss the map and fall through to the same default by
      // accident rather than by intent.
      status: (r.status as string | null) ?? 'UNKNOWN',
      genres: (r.genres as string | null) ?? '',
      description: (r.description as string | null) ?? '',
      artist: r.artist as string | null,
      // No rating column locally — the seed has nowhere to read one from either.
      rating: null,
    },
    created_at: r.updated_at as string,
    updated_at: r.updated_at as string,
  }));
}

export interface LocalMangaChapter {
  id: string;
  source: string;
  manga_slug: string;
  source_chapter_key: string;
  manga_id: string;
  url: string;
  name: string | null;
  scanlator: string | null;
  is_read: boolean;
  is_bookmark: boolean;
  chapter_number: number;
  last_page_read: number;
  page_count: number | null;
  /** Not tracked locally — always null. Matches MangaChapterRecord's shape. */
  fetched_at: string | null;
  release_date: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * `manga_detail` is deliberately excluded: GET /manga/details/:id returns these fields
 * flat (see MangaWithDetails), and that's what `fromMangaDetails` reads. Carrying the
 * nested copy as well would mean two places to keep in step for no consumer.
 */
export interface LocalMangaDetails extends Omit<LocalMangaListItem, 'manga_detail'> {
  artist: string | null;
  // Non-null to match MangaWithDetails. 'UNKNOWN' is the key STATUS_MAP looks up for a
  // missing status, so it round-trips to the same "Unknown" pill an absent value would.
  description: string;
  genres: string;
  status: string;
  /** Not tracked locally — always null. Matches MangaWithDetails's shape. */
  rating: number | null;
  chapters: LocalMangaChapter[];
}

function getMangaDetails(mangaId: string): LocalMangaDetails | null {
  const db = getDb();
  const manga = db.prepare(`SELECT * FROM manga WHERE id = ?`).get(mangaId);
  if (!manga) {
    return null;
  }

  const chapters = db
    .prepare(
      `SELECT c.id, c.source, c.manga_slug, c.source_chapter_key, c.manga_id, c.url, c.name,
              c.scanlator, c.chapter_number, c.release_date, c.page_count, c.updated_at,
              cs.is_read, cs.is_bookmark, cs.last_page_read
       FROM chapter c
       LEFT JOIN chapter_state cs ON cs.chapter_id = c.id
       WHERE c.manga_id = ?
       ORDER BY c.chapter_number ASC`,
    )
    .all(mangaId);

  return {
    id: manga.id as string,
    slug: manga.slug as string,
    title: manga.title as string,
    author: (manga.author as string | null) ?? '',
    source: (manga.source as string | null) ?? '',
    thumbnail_url: (manga.thumbnail_url as string | null) ?? '',
    artist: manga.artist as string | null,
    description: (manga.description as string | null) ?? '',
    genres: (manga.genres as string | null) ?? '',
    status: (manga.status as string | null) ?? 'UNKNOWN',
    rating: null,
    in_library: true,
    chapter_count: chapters.length,
    unread_count: chapters.filter((c) => !c.is_read).length,
    latest_chapter_date: null,
    created_at: manga.updated_at as string,
    updated_at: manga.updated_at as string,
    chapters: chapters.map((c) => ({
      id: c.id as string,
      source: c.source as string,
      manga_slug: c.manga_slug as string,
      source_chapter_key: c.source_chapter_key as string,
      manga_id: c.manga_id as string,
      url: (c.url as string | null) ?? '',
      name: c.name as string | null,
      scanlator: c.scanlator as string | null,
      chapter_number: c.chapter_number as number,
      release_date: c.release_date as string | null,
      page_count: c.page_count as number | null,
      is_read: Boolean(c.is_read),
      is_bookmark: Boolean(c.is_bookmark),
      last_page_read: (c.last_page_read as number) ?? 0,
      fetched_at: null,
      created_at: c.updated_at as string,
      updated_at: c.updated_at as string,
    })),
  };
}

// ─── Writes: reading state (the "mark chapters read" half of the local-first gate) ─────

/** A chapter as the renderer names it, plus catalog fields for standing a row up when this
 * database has never seen it. */
export interface LocalChapterStub extends LocalChapterRef {
  chapter_number?: number;
  name?: string | null;
  url?: string | null;
  page_count?: number | null;
  manga_id?: string | null;
}

/**
 * The local counterpart of the server's `resolveChapter`: this database's row for the
 * chapter a key names, created when there is none. Returns its id.
 *
 * chapter_state references chapter, and foreign keys are enforced (see connection.ts), so
 * read state needs a row to hang off even for a chapter read straight from a source.
 * `manga_id` is left null when this database has no row for the title, which is exactly
 * the case the server's own nullable column exists for.
 */
function ensureChapterRow(stub: LocalChapterStub): string {
  const db = getDb();
  const mangaId =
    (stub.manga_id && db.prepare(`SELECT 1 FROM manga WHERE id = ?`).get(stub.manga_id)
      ? stub.manga_id
      : null) ??
    (
      db
        .prepare(`SELECT id FROM manga WHERE source = ? AND slug = ?`)
        .get(stub.source, stub.manga_slug) as { id: string } | undefined
    )?.id ??
    null;
  const existing = db
    .prepare(
      `SELECT id FROM chapter WHERE source = ? AND manga_slug = ? AND source_chapter_key = ?`,
    )
    .get(stub.source, stub.manga_slug, stub.source_chapter_key) as { id: string } | undefined;
  if (existing) {
    if (stub.chapter_number !== undefined && Number.isFinite(stub.chapter_number)) {
      db.prepare(
        `UPDATE chapter SET chapter_number = ? WHERE id = ? AND chapter_number = 0 AND ? <> 0`,
      ).run(stub.chapter_number, existing.id, stub.chapter_number);
    }
    if (stub.page_count !== undefined && stub.page_count !== null && stub.page_count > 0) {
      db.prepare(
        `UPDATE chapter SET page_count = ? WHERE id = ? AND COALESCE(page_count, 0) = 0`,
      ).run(stub.page_count, existing.id);
    }
    if (mangaId) {
      db.prepare(`UPDATE chapter SET manga_id = ? WHERE id = ? AND manga_id IS NULL`).run(
        mangaId,
        existing.id,
      );
    }
    return existing.id;
  }
  const id = createId();
  db.prepare(
    `INSERT INTO chapter (id, source, manga_slug, source_chapter_key, manga_id, url, name, scanlator, chapter_number, release_date, page_count, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)`,
  ).run(
    id,
    stub.source,
    stub.manga_slug,
    stub.source_chapter_key,
    mangaId,
    stub.url ?? null,
    stub.name ?? null,
    stub.chapter_number ?? 0,
    stub.page_count ?? null,
    nowIso(),
  );
  return id;
}

function markChapterRead(stub: LocalChapterStub, isRead: boolean): void {
  const chapterId = ensureChapterRow(stub);
  setChapterRead(getDb(), chapterId, isRead, nowIso());
}

function updateChapterProgress(stub: LocalChapterStub, lastPageRead: number): void {
  const chapterId = ensureChapterRow(stub);
  setChapterPage(getDb(), chapterId, lastPageRead, nowIso());
}

// ─── History ─────────────────────────────────────────────────────────────────────────

/**
 * Mirrors api-client's HistoryEntry exactly, including its use of optional properties
 * rather than nullable ones — SQLite hands back null for an absent column, so every one
 * of these is coerced to undefined in `toHistoryEntry` rather than passed straight
 * through. The renderer reads this shape without knowing whether HTTP or this store
 * answered.
 */
export interface LocalHistoryEntry {
  id: string;
  source: string;
  manga_id?: string;
  in_library?: boolean;
  manga_slug: string;
  source_manga_id?: string;
  title?: string;
  thumbnail_url?: string;
  chapter_id?: string;
  source_chapter_key?: string;
  read_at: string;
  last_read: string;
  pages_read: number;
  time_read: number;
  chapter_number?: number;
  name?: string;
  is_read?: boolean;
  last_page_read: number;
  page_count: number;
}

/** The chapter/chapter_state join both history reads need. Kept in one place so a row
 * returned by `addHistory` carries the same fields as one returned by `listHistory` —
 * they used to differ, and the `as unknown as` cast on the add path meant the compiler
 * reported a LocalHistoryEntry either way. */
const HISTORY_SELECT = `SELECT h.*, c.source_chapter_key, c.chapter_number, c.name, c.page_count,
              CASE WHEN h.title IS NULL OR h.title = '' OR h.title = h.manga_id
                         OR h.title = h.manga_slug THEN COALESCE(m.title, h.title)
                   ELSE h.title END AS display_title,
              COALESCE(NULLIF(h.thumbnail_url, ''), m.thumbnail_url) AS display_thumbnail_url,
              COALESCE(ms.in_library, 0) AS in_library,
              COALESCE(cs.is_read, 0) AS is_read, COALESCE(cs.last_page_read, 0) AS last_page_read
       FROM history h
       LEFT JOIN manga m ON m.id = h.manga_id
       LEFT JOIN manga_state ms ON ms.manga_id = h.manga_id
       LEFT JOIN chapter c ON c.id = h.chapter_id
       LEFT JOIN chapter_state cs ON cs.chapter_id = h.chapter_id`;

/** Built field by field rather than spread-and-cast: the previous `as unknown as` hid
 * both the null/undefined mismatch above and the missing joined columns on the add path. */
function toHistoryEntry(row: Record<string, unknown>): LocalHistoryEntry {
  const optional = <T>(value: unknown): T | undefined => (value ?? undefined) as T | undefined;

  return {
    id: row.id as string,
    source: row.source as string,
    manga_id: optional<string>(row.manga_id),
    in_library: Boolean(row.in_library),
    manga_slug: row.manga_slug as string,
    source_manga_id: optional<string>(row.source_manga_id),
    title: optional<string>(row.display_title),
    thumbnail_url: optional<string>(row.display_thumbnail_url),
    chapter_id: optional<string>(row.chapter_id),
    source_chapter_key: optional<string>(row.source_chapter_key),
    read_at: row.read_at as string,
    last_read: row.last_read as string,
    pages_read: (row.pages_read as number | null) ?? 0,
    time_read: (row.time_read as number | null) ?? 0,
    chapter_number: optional<number>(row.chapter_number),
    name: optional<string>(row.name),
    is_read: Boolean(row.is_read),
    last_page_read: (row.last_page_read as number | null) ?? 0,
    page_count: (row.page_count as number | null) ?? 0,
  };
}

/** Matches GET /history's flattened shape (packages/api-client's HistoryEntry) — joins
 * in chapter/chapter_state the same way the server's query resolves them, rather than
 * leaving those fields off and letting callers silently get `undefined`. */
function listHistory(): LocalHistoryEntry[] {
  const db = getDb();
  const rows = db
    .prepare(`${HISTORY_SELECT} WHERE h.deleted_at IS NULL ORDER BY h.last_read DESC`)
    .all();

  return rows.map((r) => toHistoryEntry(r as Record<string, unknown>));
}

function deleteHistory(id: string): void {
  const deletedAt = nowIso();
  getDb()
    .prepare(`UPDATE history SET deleted_at = ?, last_read = ? WHERE id = ? AND deleted_at IS NULL`)
    .run(deletedAt, deletedAt, id);
}

function addHistory(input: LocalHistoryInput): LocalHistoryEntry {
  const db = getDb();
  const now = nowIso();

  const chapterId = input.source_chapter_key
    ? ensureChapterRow({
        source: input.source,
        manga_slug: input.manga_slug,
        source_chapter_key: input.source_chapter_key,
        manga_id: input.manga_id,
      })
    : null;
  // Deliberately not filtered on deleted_at: the server matches the row regardless and
  // then clears the tombstone, so filtering here would insert a second row for a chapter
  // whose cleared entry is still on disk — and both would then sync.
  const existing = chapterId
    ? db
        .prepare(`SELECT id FROM history WHERE source = ? AND chapter_id = ? AND manga_slug = ?`)
        .get(input.source, chapterId, input.manga_slug)
    : null;

  if (existing) {
    // Mirrors the server's own upsert (history.repository.ts's addHistory): pages_read is
    // overwritten while time_read accumulates, deleted_at is cleared so re-reading a
    // chapter undeletes a cleared entry, and title/thumbnail/manga_id are filled in when
    // this call knows them but the stored row doesn't. Without those last three, a row
    // first written straight from a source — before any manga row existed to name it —
    // stayed untitled and coverless locally forever, while the same read through the
    // server filled them in on the next visit.
    db.prepare(
      `UPDATE history
          SET pages_read = ?,
              time_read = time_read + ?,
              last_read = ?,
              deleted_at = NULL,
              manga_id = COALESCE(?, manga_id),
              title = COALESCE(?, title),
              source_manga_id = COALESCE(?, source_manga_id),
              thumbnail_url = COALESCE(?, thumbnail_url)
        WHERE id = ?`,
    ).run(
      input.pages_read ?? 0,
      input.time_read ?? 0,
      now,
      input.manga_id ?? null,
      input.title ?? null,
      input.source_manga_id ?? null,
      input.thumbnail_url ?? null,
      existing.id,
    );
    return toHistoryEntry(
      db.prepare(`${HISTORY_SELECT} WHERE h.id = ?`).get(existing.id) as Record<string, unknown>,
    );
  }

  const id = input.id ?? createId();
  db.prepare(
    `INSERT INTO history (id, source, manga_id, manga_slug, source_manga_id, title, thumbnail_url, chapter_id, read_at, last_read, pages_read, time_read)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.source,
    input.manga_id ?? null,
    input.manga_slug,
    input.source_manga_id ?? null,
    input.title ?? null,
    input.thumbnail_url ?? null,
    chapterId,
    now,
    now,
    // `|| 1` not `?? 0`, matching the server: a history row exists because a chapter was
    // opened, so "zero pages read" understates it and would disagree with the same read
    // recorded online.
    input.pages_read || 1,
    input.time_read ?? 0,
  );

  return toHistoryEntry(
    db.prepare(`${HISTORY_SELECT} WHERE h.id = ?`).get(id) as Record<string, unknown>,
  );
}

// ─── Seed: one-time/on-reconnect pull from the server (not a full sync — no push, no
// conflict resolution, just "copy what's there" — see the Sync section below) ────

/** Every request the seed makes. Without a deadline a server that accepts the connection
 * but never answers would hang the seed — and its floating promise — for the life of the
 * process. */
const SEED_REQUEST_TIMEOUT_MS = 15_000;

function fetchWithTimeout(url: string, session: CachedSession | null): Promise<Response> {
  return fetch(url, {
    signal: AbortSignal.timeout(SEED_REQUEST_TIMEOUT_MS),
    headers: session ? { Cookie: `${SESSION_COOKIE_NAME}=${session.session_id}` } : undefined,
    redirect: session ? 'error' : 'follow',
  });
}

function assertSeedAccount(session: CachedSession | null): void {
  if ((getCachedSession()?.user_id ?? null) !== (session?.user_id ?? null)) {
    throw new Error('Account changed during local seed; retry for the current account');
  }
}

interface ServerMangaDetails {
  id: string;
  slug: string;
  title: string;
  author: string;
  source: string;
  thumbnail_url: string;
  artist: string | null;
  description: string;
  genres: string;
  status: string;
  chapters: Array<{
    id: string;
    source: string;
    manga_slug: string;
    source_chapter_key: string;
    url: string;
    name: string | null;
    scanlator: string | null;
    chapter_number: number;
    release_date: string | null;
    page_count: number | null;
    is_read: boolean;
    is_bookmark: boolean;
    last_page_read: number;
  }>;
}

/**
 * Pulls one manga's details from the API and writes it, with its chapters, into the local
 * database. Resolves to whether anything was written.
 *
 * Shared by the startup seed and by the add-to-library path, and that sharing is the point.
 * The library list is served from *this* database (ipc.ts's `manga`/`listLibrary`), while
 * adding a title goes over HTTP to the API's own database — two stores, and nothing wrote
 * the second one back into the first except the startup seed. So a title added mid-session
 * was simply absent from the library until the app was restarted, and re-adding it failed
 * with "couldn't add" because the API already had the row. Re-reading the row from the API
 * rather than mirroring the client's payload keeps one authority for what a manga is: the
 * id the server assigned, and the fields it actually stored.
 */
/**
 * Drops local chapters of a title the server no longer lists, when nothing hangs off them.
 * One with progress or history may be a local-first mark the server has not received yet,
 * so it stays. (A server relink keeps the row id, so it never shows up here.)
 */
function dropUnlistedChapters(mangaId: string, listedIds: Set<string>): void {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT c.id FROM chapter c LEFT JOIN chapter_state cs ON cs.chapter_id = c.id
       WHERE c.manga_id = ?
         AND COALESCE(cs.is_read, 0) = 0 AND COALESCE(cs.is_bookmark, 0) = 0
         AND COALESCE(cs.last_page_read, 0) = 0
         AND NOT EXISTS (SELECT 1 FROM history h WHERE h.chapter_id = c.id)`,
    )
    .all(mangaId) as { id: string }[];
  for (const row of rows) {
    if (!listedIds.has(row.id)) db.prepare(`DELETE FROM chapter WHERE id = ?`).run(row.id);
  }
}

async function syncMangaFromServer(
  apiBaseUrl: string,
  mangaId: string,
  session: CachedSession | null = getCachedSession(),
  membership: LibraryMembership = 'ifMissing',
): Promise<boolean> {
  if (session) requireSecureAccountTransport(apiBaseUrl);
  // Encoded: an id containing a slash or '?' would otherwise reshape the request path
  // into a different endpoint entirely.
  const detailsRes = await fetchWithTimeout(
    `${apiBaseUrl}/manga/details/${encodeURIComponent(mangaId)}`,
    session,
  );
  assertSeedAccount(session);
  if (!detailsRes.ok) {
    return false;
  }
  const { data: details } = (await detailsRes.json()) as { data: ServerMangaDetails };
  if (!details || typeof details.id !== 'string') return false;

  // A details payload without a chapters array is still a usable manga row, so store it
  // and skip the chapters rather than throwing.
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    upsertManga(details, membership);
    for (const chapter of details.chapters ?? []) {
      upsertChapter({
        ...chapter,
        source: details.source,
        manga_slug: details.slug,
        manga_id: details.id,
      });
    }
    if (details.chapters?.length) {
      dropUnlistedChapters(details.id, new Set(details.chapters.map((chapter) => chapter.id)));
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  // A source-only read can predate this library row. Keep its saved history attached
  // after the title is added, just as the server's add path does for the same chapter ids.
  getDb()
    .prepare(
      `UPDATE history SET manga_id = ? WHERE manga_id IS NULL AND source = ? AND manga_slug = ?`,
    )
    .run(details.id, details.source, details.slug);
  return true;
}

async function seedFromServer(
  apiBaseUrl: string,
): Promise<{ mangaCount: number; historyCount: number }> {
  const session = getCachedSession();
  if (session) requireSecureAccountTransport(apiBaseUrl);
  const mangaRes = await fetchWithTimeout(`${apiBaseUrl}/manga`, session);
  assertSeedAccount(session);
  if (!mangaRes.ok) {
    throw new Error(`Seed failed: GET /manga returned ${mangaRes.status}`);
  }
  const mangaListEnvelope = (await mangaRes.json()) as { data?: Array<{ id?: string }> };

  let mangaCount = 0;

  // The envelope is a parsed HTTP body, not a guaranteed shape: an error page or an
  // envelope without `data` would make this `for...of` throw "undefined is not iterable"
  // and abort the whole seed, rather than seeding nothing and moving on.
  for (const item of mangaListEnvelope.data ?? []) {
    if (typeof item?.id !== 'string' || item.id.length === 0) continue;
    try {
      if (await syncMangaFromServer(apiBaseUrl, item.id, session)) {
        mangaCount++;
      }
    } catch (error) {
      // One title clashing with a local row (the same source and slug under another id)
      // shouldn't cost every title after it. Anything else is a real failure.
      if (!(error instanceof Error) || !error.message.includes('UNIQUE constraint')) throw error;
      console.warn('[seed] Skipped a title that clashes with a local row');
    }
  }

  const historyRes = await fetchWithTimeout(`${apiBaseUrl}/history`, session);
  assertSeedAccount(session);
  let historyCount = 0;
  if (historyRes.ok) {
    const { data: historyRows } = (await historyRes.json()) as {
      data?: Array<{
        id?: string;
        source: string;
        manga_id: string | null;
        manga_slug: string;
        source_manga_id?: string | null;
        title: string | null;
        thumbnail_url: string | null;
        source_chapter_key?: string | null;
        read_at?: string;
        last_read?: string;
        pages_read: number;
        time_read: number;
      }>;
    };
    const db = getDb();
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of historyRows ?? []) {
        if (!row?.id || typeof row.source !== 'string' || typeof row.manga_slug !== 'string') {
          continue;
        }
        const chapterId = row.source_chapter_key
          ? ensureChapterRow({
              source: row.source,
              manga_slug: row.manga_slug,
              source_chapter_key: row.source_chapter_key,
              manga_id: row.manga_id,
            })
          : null;
        // The server's own times: "now" would reorder the whole list, and read as new edits.
        const lastRead = row.last_read ?? FROM_SERVER;
        db.prepare(
          `INSERT OR IGNORE INTO history (id, source, manga_id, manga_slug, source_manga_id, title, thumbnail_url, chapter_id, read_at, last_read, pages_read, time_read)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          row.id,
          row.source,
          // node:sqlite's parameter binding only accepts null, not undefined — the server
          // omits these keys entirely for a source-only read rather than sending an
          // explicit null (see packages/api-client's HistoryEntry: manga_id?, title?,
          // thumbnail_url? are all optional, not nullable), so every one of these needs
          // the same `?? null` coercion.
          row.manga_id ?? null,
          row.manga_slug,
          row.source_manga_id ?? null,
          row.title ?? null,
          row.thumbnail_url ?? null,
          chapterId,
          row.read_at ?? lastRead,
          lastRead,
          row.pages_read ?? 0,
          row.time_read ?? 0,
        );
        historyCount++;
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  const db = getDb();
  db.prepare(
    `INSERT INTO sync_meta (domain, last_pulled_at) VALUES ('seed', ?)
     ON CONFLICT(domain) DO UPDATE SET last_pulled_at = excluded.last_pulled_at`,
  ).run(nowIso());

  // Counts rows actually written, not rows the list mentioned: entries whose details
  // fetch 404s or comes back malformed are skipped above, and reporting them as seeded
  // made a partial seed look like a complete one.
  return { mangaCount, historyCount };
}

/** Rebuilds this identity's local view after an authoritative server-side replacement.
 * Fetch everything first, then swap local state atomically so an interrupted renderer
 * cannot leave a half-cleared offline library. Catalog rows may remain as harmless cache. */
/**
 * Reading done on this device that the server hasn't been sent yet: what a restore that
 * replaces the library must not wipe.
 *
 * A restore runs in the background, so the reader can keep going while it does; their
 * progress is saved here and waits, since the server refuses pushes until the restore is
 * done. Replacing this database's copy with the restored one then deleted it. Collected by
 * source key, which survives the replace, unlike a row's place in these tables.
 */
interface UnsentLocalChanges {
  chapterStates: Array<{
    source: string;
    manga_slug: string;
    source_chapter_key: string;
    manga_id: string | null;
    is_read: number;
    is_bookmark: number;
    last_page_read: number;
  }>;
  mangaStates: Array<{
    manga_id: string;
    in_library: number;
    is_bookmarked: number;
    shelf_status: string | null;
    notification_read: number;
  }>;
  history: Array<{
    id: string;
    source: string;
    manga_id: string | null;
    manga_slug: string;
    source_manga_id: string | null;
    title: string | null;
    thumbnail_url: string | null;
    source_chapter_key: string | null;
    read_at: string;
    last_read: string;
    pages_read: number;
    time_read: number;
  }>;
}

function collectUnsentLocalChanges(since: string): UnsentLocalChanges {
  const db = getDb();
  return {
    chapterStates: db
      .prepare(
        `SELECT c.source, c.manga_slug, c.source_chapter_key, c.manga_id,
                cs.is_read, cs.is_bookmark, cs.last_page_read
         FROM chapter_state cs JOIN chapter c ON c.id = cs.chapter_id
         WHERE cs.updated_at > ? AND c.source <> '' AND c.manga_slug <> ''`,
      )
      .all(since) as unknown as UnsentLocalChanges['chapterStates'],
    mangaStates: db
      .prepare(
        `SELECT manga_id, in_library, is_bookmarked, shelf_status, notification_read
         FROM manga_state WHERE updated_at > ?`,
      )
      .all(since) as unknown as UnsentLocalChanges['mangaStates'],
    history: db
      .prepare(
        `SELECT h.id, h.source, h.manga_id, h.manga_slug, h.source_manga_id, h.title,
                h.thumbnail_url, c.source_chapter_key, h.read_at, h.last_read, h.pages_read,
                h.time_read
         FROM history h LEFT JOIN chapter c ON c.id = h.chapter_id
         WHERE h.last_read > ? AND h.deleted_at IS NULL`,
      )
      .all(since) as unknown as UnsentLocalChanges['history'],
  };
}

/**
 * Puts unsent reading back on top of the restored copy, stamped `at` (after the restore's
 * own snapshot) so the next sync sends it.
 *
 * History is sent by its `last_read` time, so a re-applied entry's moves up to `at`: off
 * by at most how long the restore took, rather than never reaching the server.
 */
function reapplyUnsentLocalChanges(changes: UnsentLocalChanges, at: string): void {
  const db = getDb();
  for (const state of changes.chapterStates) {
    const chapterId = ensureChapterRow({
      source: state.source,
      manga_slug: state.manga_slug,
      source_chapter_key: state.source_chapter_key,
      manga_id: state.manga_id,
      name: '',
      chapter_number: 0,
      page_count: null,
    });
    overwriteChapterState(db, chapterId, state, at);
  }
  for (const state of changes.mangaStates) {
    // A title the restore left without a row here has nothing to attach the state to.
    if (!db.prepare(`SELECT 1 FROM manga WHERE id = ?`).get(state.manga_id)) continue;
    db.prepare(
      `INSERT INTO manga_state (manga_id, in_library, is_bookmarked, shelf_status, notification_read, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(manga_id) DO UPDATE SET
         in_library = excluded.in_library, is_bookmarked = excluded.is_bookmarked,
         shelf_status = excluded.shelf_status, notification_read = excluded.notification_read,
         updated_at = excluded.updated_at`,
    ).run(
      state.manga_id,
      state.in_library,
      state.is_bookmarked,
      state.shelf_status,
      state.notification_read,
      at,
    );
  }
  for (const row of changes.history) {
    const chapterId = row.source_chapter_key
      ? ensureChapterRow({
          source: row.source,
          manga_slug: row.manga_slug,
          source_chapter_key: row.source_chapter_key,
          manga_id: row.manga_id,
          name: '',
          chapter_number: 0,
          page_count: null,
        })
      : null;
    const lastRead = row.last_read > at ? row.last_read : at;
    db.prepare(
      `INSERT INTO history (id, source, manga_id, manga_slug, source_manga_id, title, thumbnail_url, chapter_id, read_at, last_read, pages_read, time_read)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_read = excluded.last_read,
         pages_read = MAX(history.pages_read, excluded.pages_read),
         time_read = MAX(history.time_read, excluded.time_read), deleted_at = NULL`,
    ).run(
      row.id,
      row.source,
      row.manga_id,
      row.manga_slug,
      row.source_manga_id,
      row.title,
      row.thumbnail_url,
      chapterId,
      row.read_at,
      lastRead,
      row.pages_read,
      row.time_read,
    );
  }
}

async function reconcileRestoreFromServer(
  apiBaseUrl: string,
  mode: 'merge' | 'replace' = 'replace',
  /** When the restore started; reading after it is kept. Defaults to the last push. */
  keepChangesSince?: string,
): Promise<void> {
  const session = getCachedSession();
  if (session) requireSecureAccountTransport(apiBaseUrl);
  const read = async <T>(path: string): Promise<T> => {
    const response = await fetchWithTimeout(`${apiBaseUrl}${path}`, session);
    assertSeedAccount(session);
    if (!response.ok)
      throw new Error(`Restore reconciliation failed: ${path} returned ${response.status}`);
    const envelope = (await response.json()) as { success?: boolean; data?: T };
    if (!envelope.success || envelope.data === undefined)
      throw new Error('Restore reconciliation received invalid server data');
    return envelope.data;
  };
  const [mangaList, states, historyRows, syncState] = await Promise.all([
    read<Array<{ id: string }>>('/manga'),
    read<
      Array<{
        manga_id: string;
        is_bookmarked: boolean;
        shelf_status: string | null;
        notification_read: boolean;
      }>
    >('/library'),
    read<
      Array<{
        id: string;
        source: string;
        manga_id?: string;
        manga_slug: string;
        source_manga_id?: string;
        title?: string;
        thumbnail_url?: string;
        source_chapter_key?: string;
        read_at: string;
        last_read: string;
        pages_read: number;
        time_read: number;
        chapter_number?: number;
        name?: string;
        is_read?: boolean;
        last_page_read?: number;
        page_count?: number;
      }>
    >('/history'),
    session ? read<{ generation: number }>('/sync/generation') : Promise.resolve(null),
  ]);
  if (syncState && (!Number.isSafeInteger(syncState.generation) || syncState.generation < 0))
    throw new Error('Restore reconciliation received invalid sync generation');
  if (!Array.isArray(mangaList) || !Array.isArray(states) || !Array.isArray(historyRows)) {
    throw new Error('Restore reconciliation received invalid lists');
  }
  const details: ServerMangaDetails[] = [];
  for (let index = 0; index < mangaList.length; index += 8) {
    const batch = mangaList.slice(index, index + 8);
    details.push(
      ...(await Promise.all(
        batch.map((item) =>
          read<ServerMangaDetails>(`/manga/details/${encodeURIComponent(item.id)}`),
        ),
      )),
    );
  }
  assertSeedAccount(session);
  const catalogIds = new Set(details.map((manga) => manga.id));
  const db = getDb();
  const effectiveMode =
    mode === 'merge' && syncState && syncState.generation > (getSyncGeneration() ?? 0)
      ? 'replace'
      : mode;
  db.exec('BEGIN IMMEDIATE');
  try {
    const existingIds = new Set(
      effectiveMode === 'merge'
        ? (
            db.prepare('SELECT manga_id FROM manga_state WHERE in_library = 1').all() as {
              manga_id: string;
            }[]
          ).map((row) => row.manga_id)
        : [],
    );
    // Read before the replace wipes it: reading the server hasn't been sent, which a restore
    // in the background (or on another device) must not take away.
    // Kept: what is both unsent and, when this device started the restore, newer than its
    // start. Reading from before it is what the restore replaces.
    const sendSince = getSyncCursor().last_pushed_at;
    const keepSince =
      keepChangesSince && sendSince
        ? keepChangesSince > sendSince
          ? keepChangesSince
          : sendSince
        : (keepChangesSince ?? sendSince);
    const unsent =
      effectiveMode === 'replace' && keepSince ? collectUnsentLocalChanges(keepSince) : null;
    if (effectiveMode === 'replace')
      db.exec('DELETE FROM history; DELETE FROM chapter_state; DELETE FROM manga_state;');
    for (const manga of details) {
      if (!manga || typeof manga.id !== 'string' || !Array.isArray(manga.chapters))
        throw new Error('Invalid title in restore reconciliation');
      upsertManga(manga);
      for (const chapter of manga.chapters) {
        upsertChapter({
          ...chapter,
          source: manga.source,
          manga_slug: manga.slug,
          manga_id: manga.id,
        });
      }
    }
    const stamped = nowIso();
    for (const state of states) {
      if (existingIds.has(state.manga_id)) continue;
      db.prepare(
        `UPDATE manga_state SET is_bookmarked = ?, shelf_status = ?, notification_read = ?, updated_at = ? WHERE manga_id = ?`,
      ).run(
        state.is_bookmarked ? 1 : 0,
        state.shelf_status ?? null,
        state.notification_read ? 1 : 0,
        stamped,
        state.manga_id,
      );
    }
    for (const row of historyRows) {
      if (
        typeof row.id !== 'string' ||
        typeof row.source !== 'string' ||
        typeof row.manga_slug !== 'string'
      )
        throw new Error('Invalid history in restore reconciliation');
      if (effectiveMode === 'merge') {
        const duplicate = db
          .prepare(
            `SELECT 1 FROM history h LEFT JOIN chapter c ON c.id = h.chapter_id
             WHERE h.source = ? AND h.manga_slug = ? AND IFNULL(c.source_chapter_key, '') = ?
             LIMIT 1`,
          )
          .get(row.source, row.manga_slug, row.source_chapter_key ?? '');
        if (duplicate) continue;
      }
      const chapterId = row.source_chapter_key
        ? ensureChapterRow({
            source: row.source,
            manga_slug: row.manga_slug,
            source_chapter_key: row.source_chapter_key,
            manga_id: row.manga_id && catalogIds.has(row.manga_id) ? row.manga_id : null,
            name: row.name ?? '',
            chapter_number: row.chapter_number ?? 0,
            page_count: row.page_count ?? null,
          })
        : null;
      if (chapterId) {
        foldChapterState(
          db,
          chapterId,
          { is_read: row.is_read, last_page_read: row.last_page_read },
          stamped,
          'always',
        );
      }
      db.prepare(
        `INSERT INTO history (id, source, manga_id, manga_slug, source_manga_id, title, thumbnail_url, chapter_id, read_at, last_read, pages_read, time_read) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.id,
        row.source,
        row.manga_id ?? null,
        row.manga_slug,
        row.source_manga_id ?? null,
        row.title ?? null,
        row.thumbnail_url ?? null,
        chapterId,
        row.read_at,
        row.last_read,
        row.pages_read,
        row.time_read,
      );
    }
    // The sync protocol has one combined cursor. Mark the downloaded snapshot as
    // already pushed, then force a full pull on the next sync rather than trusting
    // this device's clock as a server watermark.
    if (effectiveMode === 'replace')
      db.prepare(
        `INSERT INTO sync_meta (domain, last_pulled_at, last_pushed_at) VALUES ('sync', NULL, ?)
       ON CONFLICT(domain) DO UPDATE SET last_pulled_at = NULL, last_pushed_at = excluded.last_pushed_at`,
      ).run(stamped);
    // After the snapshot and the push cursor, so the next sync sends it.
    if (unsent) reapplyUnsentLocalChanges(unsent, new Date(Date.parse(stamped) + 1).toISOString());
    if (syncState) setSyncGeneration(syncState.generation);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// ─── Sync: push local changes since the last successful push, then apply the
// server's merged state onto the local DB. One cursor row ("sync"), matching the
// server's own single server_time cursor for every domain together — the push and pull
// endpoints both operate on all domains in one round trip, so per-domain cursors would
// just be extra bookkeeping with nothing to key them off. ───────────────────────────────

export interface SyncCursor {
  last_pulled_at: string | null;
  last_pushed_at: string | null;
}

function getSyncCursor(): SyncCursor {
  const db = getDb();
  const row = db
    .prepare(`SELECT last_pulled_at, last_pushed_at FROM sync_meta WHERE domain = 'sync'`)
    .get() as { last_pulled_at: string | null; last_pushed_at: string | null } | undefined;
  return row ?? { last_pulled_at: null, last_pushed_at: null };
}

function setSyncCursor(patch: Partial<SyncCursor>): void {
  const db = getDb();
  const current = getSyncCursor();
  const merged = { ...current, ...patch };
  db.prepare(
    `INSERT INTO sync_meta (domain, last_pulled_at, last_pushed_at) VALUES ('sync', ?, ?)
     ON CONFLICT(domain) DO UPDATE SET last_pulled_at = excluded.last_pulled_at, last_pushed_at = excluded.last_pushed_at`,
  ).run(merged.last_pulled_at, merged.last_pushed_at);
}

function getSyncGeneration(): number | null {
  const row = getDb()
    .prepare(`SELECT last_pulled_at FROM sync_meta WHERE domain = 'generation'`)
    .get() as { last_pulled_at: string | null } | undefined;
  if (!row?.last_pulled_at) return null;
  const value = Number(row.last_pulled_at);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function setSyncGeneration(generation: number): void {
  if (!Number.isSafeInteger(generation) || generation < 0)
    throw new Error('Invalid sync generation');
  getDb()
    .prepare(
      `INSERT INTO sync_meta (domain, last_pulled_at) VALUES ('generation', ?)
     ON CONFLICT(domain) DO UPDATE SET last_pulled_at = excluded.last_pulled_at`,
    )
    .run(String(generation));
}

export interface PendingSyncPush {
  library: { manga_id: string; deleted_at: string | null; updated_at: string }[];
  manga_state: {
    manga_id: string;
    is_bookmarked: boolean;
    shelf_status: string | null;
    notification_read: boolean;
    updated_at: string;
  }[];
  chapter_state: (LocalChapterRef & {
    is_read: boolean;
    is_bookmark: boolean;
    last_page_read: number;
    updated_at: string;
  })[];
  manga_category: {
    manga_id: string;
    category_name: string;
    deleted_at: string | null;
    updated_at: string;
  }[];
  history: {
    id: string;
    source: string;
    manga_id: string | null;
    manga_slug: string;
    source_manga_id?: string | null;
    title: string | null;
    thumbnail_url: string | null;
    source_chapter_key: string | null;
    read_at: string;
    last_read: string;
    pages_read: number;
    time_read: number;
    deleted_at: string | null;
  }[];
}

/** Reads every local row changed since the last successful push. manga_state doubles as
 * the source for both the library and manga_state push domains — in_library is this
 * table's own column (see migrate.ts's doc comment on why there's no separate local
 * user_library table: one account's data at a time locally, so the distinction the
 * server needs between two tables doesn't buy anything on this side). */
function getPendingChanges(): PendingSyncPush {
  const db = getDb();
  const since = getSyncCursor().last_pushed_at ?? '1970-01-01T00:00:00.000Z';

  const mangaStateRows = db
    .prepare(
      `SELECT manga_id, in_library, is_bookmarked, shelf_status, notification_read, updated_at
       FROM manga_state WHERE updated_at > ?`,
    )
    .all(since) as {
    manga_id: string;
    in_library: number;
    is_bookmarked: number;
    shelf_status: string | null;
    notification_read: number;
    updated_at: string;
  }[];

  // Named by source key: this device's row ids are its own. A stub with no title yet
  // (source '') has nothing the server could file it under, so it waits.
  const chapterStateRows = db
    .prepare(
      `SELECT c.source, c.manga_slug, c.source_chapter_key,
              cs.is_read, cs.is_bookmark, cs.last_page_read, cs.updated_at
       FROM chapter_state cs JOIN chapter c ON c.id = cs.chapter_id
       WHERE cs.updated_at > ? AND c.source <> '' AND c.manga_slug <> ''`,
    )
    .all(since) as {
    source: string;
    manga_slug: string;
    source_chapter_key: string;
    is_read: number;
    is_bookmark: number;
    last_page_read: number;
    updated_at: string;
  }[];

  const mangaCategoryRows = db
    .prepare(
      `SELECT mc.manga_id, c.name AS category_name, mc.updated_at
       FROM manga_category mc JOIN category c ON c.id = mc.category_id
       WHERE mc.updated_at > ?`,
    )
    .all(since) as { manga_id: string; category_name: string; updated_at: string }[];

  const historyRows = db
    .prepare(
      `SELECT h.id, h.source, h.manga_id, h.manga_slug, h.source_manga_id, h.title, h.thumbnail_url,
              c.source_chapter_key, h.read_at, h.last_read, h.pages_read, h.time_read, h.deleted_at
       FROM history h LEFT JOIN chapter c ON c.id = h.chapter_id
       WHERE h.last_read > ?`,
    )
    .all(since) as unknown as PendingSyncPush['history'];

  return {
    library: mangaStateRows.map((r) => ({
      manga_id: r.manga_id,
      deleted_at: r.in_library ? null : r.updated_at,
      updated_at: r.updated_at,
    })),
    manga_state: mangaStateRows.map((r) => ({
      manga_id: r.manga_id,
      is_bookmarked: Boolean(r.is_bookmarked),
      shelf_status: r.shelf_status,
      notification_read: Boolean(r.notification_read),
      updated_at: r.updated_at,
    })),
    chapter_state: chapterStateRows.map((r) => ({
      source: r.source,
      manga_slug: r.manga_slug,
      source_chapter_key: r.source_chapter_key,
      is_read: Boolean(r.is_read),
      is_bookmark: Boolean(r.is_bookmark),
      last_page_read: r.last_page_read,
      updated_at: r.updated_at,
    })),
    manga_category: mangaCategoryRows.map((r) => ({
      manga_id: r.manga_id,
      category_name: r.category_name,
      deleted_at: null,
      updated_at: r.updated_at,
    })),
    history: historyRows,
  };
}

export interface PulledSyncData {
  server_time: string;
  /** `updated_at` is the server's write time (what the pull cursor walks); `edited_at`,
   * when present, is when the change was made on the device that made it. */
  library: {
    manga_id: string;
    deleted_at: string | null;
    updated_at: string;
    edited_at?: string | null;
  }[];
  manga_state: {
    manga_id: string;
    is_bookmarked: boolean;
    shelf_status: string | null;
    notification_read: boolean;
    updated_at: string;
    edited_at?: string | null;
  }[];
  chapter_state: (LocalChapterRef & {
    is_read: boolean;
    is_bookmark: boolean;
    last_page_read: number;
    updated_at: string;
  })[];
  manga_category: {
    manga_id: string;
    category_id: string;
    deleted_at: string | null;
    updated_at: string;
    edited_at?: string | null;
  }[];
  history: {
    id: string;
    source: string;
    manga_id: string | null;
    manga_slug: string;
    source_manga_id?: string | null;
    title: string | null;
    thumbnail_url: string | null;
    source_chapter_key: string | null;
    read_at: string;
    last_read: string;
    pages_read: number;
    time_read: number;
    deleted_at: string | null;
  }[];
  categories: { id: string; name: string }[];
}

export interface ApplyPulledChangesResult {
  /** How many rows across every domain were skipped because they reference a manga/
   * chapter this device hasn't cached locally yet. */
  skippedCount: number;
  /** The earliest `updated_at` among skipped rows, or null if nothing was skipped. The
   * caller (sync.ts) must not advance its pull cursor past this — a skipped row's
   * updated_at is <= the pull's own server_time, and the server's delta query is a
   * strict `updated_at > cursor`, so once the cursor passes it that row is gone from
   * every future pull for good, with no way to notice or retry it. */
  minSkippedUpdatedAt: string | null;
}

/** Applies the server's already-merged state onto the local DB. This never runs its own
 * conflict resolution — the server is the merge authority (see sync.service.ts on the
 * server), so a pulled row simply overwrites the local one. A row referencing a manga/
 * chapter this device hasn't cached locally is skipped rather than inserted — sync only
 * covers existing data, so there's no scraper here to backfill a catalog entry this device has never seen — but the skip is reported
 * back (see ApplyPulledChangesResult) so the caller doesn't lose that row forever. */
/** The local copy keeps the original edit time, not the server's write time: the next push
 * sends rows changed after the last push, so stamping pulled rows with the (later) server
 * time sent every pulled change straight back as if this device had made it. */
const editedAt = (row: { updated_at: string; edited_at?: string | null }) =>
  row.edited_at ?? row.updated_at;

function applyPulledChanges(pulled: PulledSyncData): ApplyPulledChangesResult {
  const db = getDb();

  const mangaExists = (manga_id: string) =>
    !!db.prepare(`SELECT 1 FROM manga WHERE id = ?`).get(manga_id);

  // manga_state backs two pulled domains (library and manga_state) that share one local
  // updated_at, so "is the local row newer" is judged against the value from before this
  // pass started — otherwise applying one domain would make the other look stale.
  const originalStateStamp = new Map<string, string | null>();
  const localStateIsNewer = (manga_id: string, incoming: string) => {
    if (!originalStateStamp.has(manga_id)) {
      const row = db
        .prepare(`SELECT updated_at FROM manga_state WHERE manga_id = ?`)
        .get(manga_id) as { updated_at: string } | undefined;
      originalStateStamp.set(manga_id, row?.updated_at ?? null);
    }
    const local = originalStateStamp.get(manga_id);
    return local != null && local > incoming;
  };

  let skippedCount = 0;
  let minSkippedUpdatedAt: string | null = null;
  const noteSkipped = (updatedAt: string) => {
    skippedCount += 1;
    if (minSkippedUpdatedAt === null || updatedAt < minSkippedUpdatedAt) {
      minSkippedUpdatedAt = updatedAt;
    }
  };

  // One transaction: a failure part-way (or a crash) must not leave some domains pulled and
  // the rest not while the caller's cursor is still behind them.
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const cat of pulled.categories) {
      // Names are unique here, and a server that moved to per-account categories sends a
      // new id for a name this device already holds. Without this the insert below would
      // fail the transaction, and with it every pull from then on.
      const renumbered = db
        .prepare(`SELECT id FROM category WHERE name = ? AND id <> ?`)
        .get(cat.name, cat.id) as { id: string } | undefined;
      if (renumbered) {
        db.prepare(`UPDATE category SET name = name || char(0) || id WHERE id = ?`).run(
          renumbered.id,
        );
      }
      db.prepare(
        `INSERT INTO category (id, name, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name`,
      ).run(cat.id, cat.name, nowIso());
      if (renumbered) {
        db.prepare(`UPDATE OR IGNORE manga_category SET category_id = ? WHERE category_id = ?`).run(
          cat.id,
          renumbered.id,
        );
        db.prepare(`DELETE FROM category WHERE id = ?`).run(renumbered.id);
      }
    }

    // A pulled row never overwrites a local row edited after it: that local edit has not
    // been pushed yet (or the server would have returned it), and the next push carries it.
    for (const row of pulled.manga_state) {
      if (!mangaExists(row.manga_id)) {
        noteSkipped(row.updated_at);
        continue;
      }
      if (localStateIsNewer(row.manga_id, editedAt(row))) continue;
      db.prepare(
        `INSERT INTO manga_state (manga_id, is_bookmarked, shelf_status, notification_read, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(manga_id) DO UPDATE SET
           is_bookmarked = excluded.is_bookmarked, shelf_status = excluded.shelf_status,
           notification_read = excluded.notification_read, updated_at = excluded.updated_at`,
      ).run(
        row.manga_id,
        row.is_bookmarked ? 1 : 0,
        row.shelf_status,
        row.notification_read ? 1 : 0,
        editedAt(row),
      );
    }

    for (const row of pulled.library) {
      if (!mangaExists(row.manga_id)) {
        noteSkipped(row.updated_at);
        continue;
      }
      if (localStateIsNewer(row.manga_id, editedAt(row))) continue;
      db.prepare(
        `INSERT INTO manga_state (manga_id, in_library, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(manga_id) DO UPDATE SET in_library = excluded.in_library, updated_at = excluded.updated_at`,
      ).run(row.manga_id, row.deleted_at ? 0 : 1, editedAt(row));
    }

    // Unlike the other domains the server keeps no separate edit time for chapter_state
    // (it merges progress monotonically on push), so `updated_at` is all there is to compare.
    // A chapter this device has not stored yet gets a stub by its key, like a local read
    // would, rather than being skipped: the key is all a row needs.
    for (const row of pulled.chapter_state) {
      const chapterId = ensureChapterRow(row);
      adoptPulledChapterState(db, chapterId, row, row.updated_at);
    }

    for (const row of pulled.manga_category) {
      if (!mangaExists(row.manga_id)) {
        noteSkipped(row.updated_at);
        continue;
      }
      if (row.deleted_at) {
        db.prepare(
          `DELETE FROM manga_category WHERE manga_id = ? AND category_id = ? AND updated_at <= ?`,
        ).run(row.manga_id, row.category_id, editedAt(row));
        continue;
      }
      db.prepare(
        `INSERT INTO manga_category (manga_id, category_id, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(manga_id, category_id) DO UPDATE SET updated_at = excluded.updated_at
         WHERE manga_category.updated_at <= excluded.updated_at`,
      ).run(row.manga_id, row.category_id, editedAt(row));
    }

    for (const row of pulled.history) {
      if (row.deleted_at) {
        db.prepare(`UPDATE history SET deleted_at = ? WHERE id = ? AND last_read <= ?`).run(
          row.deleted_at,
          row.id,
          row.deleted_at,
        );
        continue;
      }
      const chapterId = row.source_chapter_key
        ? ensureChapterRow({
            source: row.source,
            manga_slug: row.manga_slug,
            source_chapter_key: row.source_chapter_key,
            manga_id: row.manga_id,
          })
        : null;
      db.prepare(
        `INSERT INTO history (id, source, manga_id, manga_slug, source_manga_id, title, thumbnail_url, chapter_id, read_at, last_read, pages_read, time_read, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(id) DO UPDATE SET
           source = excluded.source, manga_id = excluded.manga_id, manga_slug = excluded.manga_slug,
           source_manga_id = excluded.source_manga_id, title = excluded.title,
           thumbnail_url = excluded.thumbnail_url, chapter_id = excluded.chapter_id,
           read_at = excluded.read_at, last_read = excluded.last_read,
           pages_read = excluded.pages_read, time_read = excluded.time_read, deleted_at = NULL
         WHERE history.last_read <= excluded.last_read`,
      ).run(
        row.id,
        row.source,
        row.manga_id,
        row.manga_slug,
        row.source_manga_id ?? null,
        row.title,
        row.thumbnail_url,
        chapterId,
        row.read_at,
        row.last_read,
        row.pages_read,
        row.time_read,
      );
    }

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return { skippedCount, minSkippedUpdatedAt };
}

/**
 * Sets (or clears) a manga's library membership locally.
 *
 * The counterpart to `syncMangaFromServer` for the remove side: removing keeps the catalog
 * row and everything hanging off it, exactly as the server's own
 * `setMangaInLibrary` does — membership is the flag, not the row's existence. Writing no
 * row when there is nothing to update keeps a remove for an unknown id a no-op rather than
 * standing up a half-populated `manga_state` row for a manga this database has never seen.
 */
function setMangaInLibrary(mangaId: string, inLibrary: boolean): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO manga_state (manga_id, in_library, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(manga_id) DO UPDATE SET in_library = excluded.in_library, updated_at = excluded.updated_at`,
  ).run(mangaId, inLibrary ? 1 : 0, nowIso());
}

export const localStore = {
  upsertManga,
  upsertChapter,
  listLibrary,
  getMangaDetails,
  markChapterRead,
  updateChapterProgress,
  listHistory,
  deleteHistory,
  addHistory,
  seedFromServer,
  reconcileRestoreFromServer,
  syncMangaFromServer,
  setMangaInLibrary,
  getSyncCursor,
  setSyncCursor,
  getSyncGeneration,
  setSyncGeneration,
  getPendingChanges,
  applyPulledChanges,
};
