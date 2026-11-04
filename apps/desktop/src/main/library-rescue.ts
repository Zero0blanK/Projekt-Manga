/**
 * Moves what only this device's anonymous local database knows onto the app's server, once.
 *
 * The app reads its server's library directly now, so titles, chapter progress and history
 * that were saved only in `local-anonymous.db` would otherwise stop showing. They go through
 * the server's restore job in merge mode, which never clears anything: titles already in the
 * server's library keep their own state, and history is de-duplicated. The local file is
 * read only and left in place. A marker file stops this running again; a failure leaves no
 * marker, so the next launch retries.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { app } from 'electron';
import { databaseFileName } from './db/database-name';

const MARKER_FILE = 'anonymous-library-rescued.json';
const MAX_MANGA = 10_000;
const MAX_HISTORY = 50_000;

type Row = Record<string, string | number | null>;

const text = (value: unknown, fallback = '') =>
  typeof value === 'string' && value ? value : fallback;
/** The restore schema takes ISO dates with an offset; anything else is left out. */
const isoDate = (value: unknown) => {
  if (typeof value !== 'string' || !value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
};

/** The restore payload for what the local database holds, or null when it holds nothing. */
export function buildRescuePayload(db: DatabaseSync) {
  const titles = db
    .prepare(
      `SELECT m.*, s.in_library, s.is_bookmarked, s.shelf_status, s.notification_read
       FROM manga m LEFT JOIN manga_state s ON s.manga_id = m.id
       WHERE s.in_library = 1
          OR m.id IN (SELECT c.manga_id FROM chapter c JOIN chapter_state cs ON cs.chapter_id = c.id
                      WHERE cs.is_read = 1 OR cs.last_page_read > 0)
       LIMIT ${MAX_MANGA}`,
    )
    .all() as Row[];
  const chapters = db.prepare(
    `SELECT c.*, cs.is_read, cs.is_bookmark, cs.last_page_read
     FROM chapter c JOIN chapter_state cs ON cs.chapter_id = c.id
     WHERE c.manga_id = ? AND (cs.is_read = 1 OR cs.is_bookmark = 1 OR cs.last_page_read > 0)`,
  );
  const manga = titles
    .filter((row) => text(row.source) && text(row.slug) && text(row.title))
    .map((row) => ({
      id: String(row.id),
      source: String(row.source),
      slug: String(row.slug),
      title: String(row.title).slice(0, 255),
      author: text(row.author, 'Unknown'),
      // Required by the schema; a value that isn't a URL shows as "no cover".
      thumbnail_url: text(row.thumbnail_url, 'none'),
      artist: typeof row.artist === 'string' ? row.artist : null,
      description: text(row.description),
      genres: text(row.genres),
      status: text(row.status, 'UNKNOWN'),
      rating: null,
      in_library: row.in_library === 1,
      chapters: (chapters.all(String(row.id)) as Row[]).map((chapter) => ({
        id: String(chapter.source_chapter_key),
        source_chapter_key: String(chapter.source_chapter_key),
        url: text(chapter.url),
        name: typeof chapter.name === 'string' ? chapter.name : null,
        scanlator: typeof chapter.scanlator === 'string' ? chapter.scanlator : null,
        chapter_number: Number(chapter.chapter_number),
        last_page_read: Math.max(0, Number(chapter.last_page_read) || 0),
        is_read: chapter.is_read === 1,
        is_bookmark: chapter.is_bookmark === 1,
        release_date: isoDate(chapter.release_date),
        page_count: typeof chapter.page_count === 'number' ? chapter.page_count : null,
      })),
    }));
  const history = (
    db
      .prepare(
        `SELECT h.*, c.source_chapter_key FROM history h LEFT JOIN chapter c ON c.id = h.chapter_id
         WHERE h.deleted_at IS NULL ORDER BY h.last_read DESC LIMIT ${MAX_HISTORY}`,
      )
      .all() as Row[]
  ).flatMap((row) => {
    const read_at = isoDate(row.read_at);
    const last_read = isoDate(row.last_read);
    if (!read_at || !last_read || !text(row.source) || !text(row.manga_slug)) return [];
    return [
      {
        source: String(row.source),
        manga_slug: String(row.manga_slug),
        title: typeof row.title === 'string' ? row.title.slice(0, 255) : null,
        thumbnail_url: typeof row.thumbnail_url === 'string' ? row.thumbnail_url : null,
        source_chapter_key: text(row.source_chapter_key) || null,
        pages_read: Math.max(0, Number(row.pages_read) || 0),
        time_read: Math.max(0, Number(row.time_read) || 0),
        read_at,
        last_read,
        last_page_read: Math.max(0, Number(row.pages_read) || 0),
      },
    ];
  });
  const owned = new Set(manga.map((entry) => entry.id));
  const library = titles
    .filter((row) => row.in_library === 1 && owned.has(String(row.id)))
    .map((row) => ({
      manga_id: String(row.id),
      is_bookmarked: row.is_bookmarked === 1,
      shelf_status: null,
      notification_read: row.notification_read === 1,
    }));
  if (!manga.length && !history.length) return null;
  return {
    mode: 'merge' as const,
    expectedUserId: null,
    version: 2 as const,
    manga,
    library,
    history,
  };
}

/** Runs the rescue once, against the app's own local server. Never throws. */
export async function rescueAnonymousLibrary(apiBaseUrl: string): Promise<void> {
  const folder = app.getPath('userData');
  const marker = path.join(folder, MARKER_FILE);
  const file = path.join(folder, databaseFileName(null));
  if (fs.existsSync(marker) || !fs.existsSync(file)) return;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const payload = buildRescuePayload(db);
    if (payload) {
      const response = await fetch(`${apiBaseUrl.replace(/\/+$/, '')}/restore/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, jobId: randomUUID() }),
        signal: AbortSignal.timeout(60_000),
        redirect: 'error',
      });
      if (!response.ok) throw new Error(`The server answered ${response.status}`);
    }
    fs.writeFileSync(marker, JSON.stringify({ rescuedAt: new Date().toISOString() }));
  } catch (error) {
    console.warn(
      `[rescue] Local library not moved yet: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  } finally {
    db?.close();
  }
}
