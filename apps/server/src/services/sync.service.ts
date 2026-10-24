import userLibraryRepository from '../repositories/userLibrary.repository.js';
import userMangaStateRepository from '../repositories/userMangaState.repository.js';
import userChapterStateRepository from '../repositories/userChapterState.repository.js';
import userMangaCategoryRepository from '../repositories/userMangaCategory.repository.js';
import historyRepository from '../repositories/history.repository.js';
import categoryRepository from '../repositories/category.repository.js';
import type { SyncPushBody } from '@projekt-manga/schemas';
import { ValidationError } from '../utils/customErrors.js';
import prisma from '../configs/prisma.config.js';
import { DuplicateResourceError } from '../utils/customErrors.js';
import { withAccountWriteLock } from '../utils/accountWriteLock.js';
import { recordDiagnosticEvent } from '../utils/diagnosticLog.js';

/**
 * The two halves of the delta-sync protocol: pull returns everything an account changed
 * (or removed) since a cursor, push applies what one device changed since its own last
 * successful push. Every domain but chapter_state resolves a conflict via last-write-win
 * on the row's own `updated_at` — chapter_state instead merges is_read/last_page_read
 * with a monotonic union so reading progress can never regress on sync (see
 * userChapterState.repository's mergeIncoming, which is the one place that rule lives).
 *
 * Login always runs one push-then-pull cycle through these same two functions — first-
 * account-claims-existing-data and second-device-with-its-own-data both fall out of the
 * same merge rules, no separate "merge" code path.
 */

/**
 * Rows per domain in one pull.
 *
 * Bounds the response so a first sync, or a device with an old cursor, does not serialise
 * an entire library into one response (push is capped by the array limits in
 * packages/schemas' sync schemas). The cap is per domain so one large domain can't starve
 * the others of their share of a page.
 */
const PULL_PAGE_SIZE = 500;

type Position = { at: string; id: string };
type Domain = 'library' | 'manga_state' | 'chapter_state' | 'manga_category' | 'history';
type Positions = Record<Domain, Position>;
const domains: Domain[] = ['library', 'manga_state', 'chapter_state', 'manga_category', 'history'];

function parseCursor(since: string | undefined): Positions {
  const initial = since && !since.startsWith('v1.') ? since : new Date(0).toISOString();
  if (!since || !since.startsWith('v1.')) {
    return Object.fromEntries(
      domains.map((domain) => [domain, { at: initial, id: '' }]),
    ) as Positions;
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(since.slice(3), 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    const positions = parsed as Record<string, unknown>;
    for (const domain of domains) {
      const position = positions[domain];
      if (!position || typeof position !== 'object' || Array.isArray(position)) throw new Error();
      const { at, id } = position as Record<string, unknown>;
      if (
        typeof at !== 'string' ||
        !Number.isFinite(Date.parse(at)) ||
        new Date(at).toISOString() !== at ||
        typeof id !== 'string' ||
        id.length > 128
      )
        throw new Error();
    }
    return positions as Positions;
  } catch {
    throw new ValidationError('Invalid sync cursor');
  }
}

/** A capped domain, plus the last row actually included. */
function pageOf<T extends { id: string }>(
  rows: T[],
  watermark: keyof T,
): { rows: T[]; truncated: boolean; last: Position | null } {
  if (rows.length <= PULL_PAGE_SIZE) {
    return { rows, truncated: false, last: null };
  }
  const page = rows.slice(0, PULL_PAGE_SIZE);
  const last = page[page.length - 1];
  return {
    rows: page,
    truncated: true,
    last: { at: (last[watermark] as Date).toISOString(), id: last.id },
  };
}

const pull = async (user_id: string, since?: string) => {
  const account = await prisma.user.findUniqueOrThrow({
    where: { id: user_id },
    select: { sync_generation: true },
  });
  // Captured before the domain queries run, so a row changed while this pull executes is
  // still included next time. No upper bound is needed: a row appearing in two consecutive
  // pulls is harmless, since every domain's apply is idempotent.
  const server_time = new Date();
  const positions = parseCursor(since);

  // One more than the page size, so "is there another page" is answered by the same
  // query rather than a second count.
  const probe = PULL_PAGE_SIZE + 1;

  const [
    libraryRows,
    mangaStateRows,
    chapterStateRows,
    mangaCategoryRows,
    historyRows,
    categories,
  ] = await Promise.all([
    userLibraryRepository.getChangedSince(
      user_id,
      new Date(positions.library.at),
      probe,
      positions.library.id,
    ),
    userMangaStateRepository.getChangedSince(
      user_id,
      new Date(positions.manga_state.at),
      probe,
      positions.manga_state.id,
    ),
    userChapterStateRepository.getChangedSince(
      user_id,
      new Date(positions.chapter_state.at),
      probe,
      positions.chapter_state.id,
    ),
    userMangaCategoryRepository.getChangedSince(
      user_id,
      new Date(positions.manga_category.at),
      probe,
      positions.manga_category.id,
    ),
    historyRepository.getChangedSince(
      user_id,
      new Date(positions.history.at),
      probe,
      positions.history.id,
    ),
    // The shared category vocabulary is small (a personal library's worth of tags) and
    // rarely changes, so it's simplest to always send the full list rather than track a
    // separate delta for it.
    categoryRepository.getCategory(),
  ]);

  const library = pageOf(libraryRows, 'updated_at');
  const manga_state = pageOf(mangaStateRows, 'updated_at');
  const chapter_state = pageOf(chapterStateRows, 'updated_at');
  const manga_category = pageOf(mangaCategoryRows, 'updated_at');
  const history = pageOf(historyRows, 'sync_updated_at');

  const pages = { library, manga_state, chapter_state, manga_category, history };
  const has_more = Object.values(pages).some((page) => page.truncated);

  /**
   * Where the next pull must resume from.
   *
   * Each capped domain retains its last (timestamp, id) pair. A shared timestamp-only
   * cursor can repeat a page forever when more than 500 rows have the same timestamp.
   * Completed domains advance to the time this pull began, so later changes stay eligible.
   */
  const next_since = has_more
    ? `v1.${Buffer.from(
        JSON.stringify(
          Object.fromEntries(
            domains.map((domain) => [
              domain,
              pages[domain].last ?? { at: server_time.toISOString(), id: '' },
            ]),
          ),
        ),
      ).toString('base64url')}`
    : server_time.toISOString();

  return {
    generation: account.sync_generation,
    server_time: server_time.toISOString(),
    /** Resume point for the next pull. Clients should store this, not server_time. */
    next_since,
    /** True when at least one domain was capped and another pull is needed. */
    has_more,
    library: library.rows,
    manga_state: manga_state.rows,
    chapter_state: chapter_state.rows,
    manga_category: manga_category.rows,
    history: history.rows,
    categories,
  };
};

interface DomainPushResult {
  applied: number;
  /** Ids of rows that failed to apply (e.g. a chapter_id/manga_id/category assignment
   * referencing something that no longer exists — a manga removed from the shared
   * catalog between this device's last sync and now is the realistic case). Every row gets
   * its own attempt and failures are reported back, rather than one bad row aborting the
   * push with earlier rows already applied. */
  failed: string[];
}

/**
 * How many rows are applied at once.
 *
 * A push carries up to 5000 chapter_state rows (see the schemas' array caps); applying
 * them strictly one at a time would mean thousands of sequential round-trips in a single
 * HTTP request. Kept modest
 * rather than unbounded because SQLite serialises writers: past a handful of concurrent
 * writes the extra requests only queue behind each other and burn the busy_timeout
 * budget. The point is to stop wasting round-trips, not to monopolise the database.
 */
const PUSH_CONCURRENCY = 5;

/** Applies every row in `rows` independently, catching per-row rather than letting one
 * failure abort the rest of the batch. Order within a domain doesn't matter: each row is
 * keyed independently and resolved by its own timestamp, so concurrency can't change the
 * outcome the way it would for an ordered log. */
async function applyEach<T>(
  rows: T[],
  keyOf: (row: T) => string,
  apply: (row: T) => Promise<unknown>,
): Promise<DomainPushResult> {
  let applied = 0;
  const failed: string[] = [];

  for (let i = 0; i < rows.length; i += PUSH_CONCURRENCY) {
    const slice = rows.slice(i, i + PUSH_CONCURRENCY);
    const outcomes = await Promise.allSettled(slice.map((row) => apply(row)));
    outcomes.forEach((outcome, index) => {
      if (outcome.status === 'fulfilled') {
        applied += 1;
      } else {
        failed.push(keyOf(slice[index]));
      }
    });
  }

  if (failed.length > 0) {
    recordDiagnosticEvent({
      level: 'warn',
      area: 'sync',
      event: 'sync.push.rows_failed',
      code: 'ROW_APPLY_FAILED',
      counts: { failed: failed.length, attempted: rows.length },
    });
  }

  return { applied, failed };
}

const push = async (user_id: string, body: SyncPushBody) =>
  withAccountWriteLock(user_id, async () => {
    const account = await prisma.user.findUniqueOrThrow({
      where: { id: user_id },
      select: { sync_generation: true },
    });
    if ((body.generation ?? 0) !== account.sync_generation)
      throw new DuplicateResourceError('Sync reset required after a library restore');
    const restoring = await prisma.restore_job.findFirst({
      where: { owner: user_id, state: { in: ['queued', 'running'] } },
      select: { id: true },
    });
    if (restoring) throw new DuplicateResourceError('Library restore is in progress');
    const library = await applyEach(
      body.library ?? [],
      (row) => row.manga_id,
      (row) =>
        userLibraryRepository.applyIncoming(
          user_id,
          row.manga_id,
          row.deleted_at ? new Date(row.deleted_at) : null,
          new Date(row.updated_at),
        ),
    );

    const manga_state = await applyEach(
      body.manga_state ?? [],
      (row) => row.manga_id,
      (row) =>
        userMangaStateRepository.applyIncoming(
          user_id,
          row.manga_id,
          {
            is_bookmarked: row.is_bookmarked,
            shelf_status: row.shelf_status,
            notification_read: row.notification_read,
          },
          new Date(row.updated_at),
        ),
    );

    const chapter_state = await applyEach(
      body.chapter_state ?? [],
      (row) => row.chapter_id,
      (row) =>
        userChapterStateRepository.mergeIncoming(user_id, row.chapter_id, {
          is_read: row.is_read,
          is_bookmark: row.is_bookmark,
          last_page_read: row.last_page_read,
          updated_at: new Date(row.updated_at),
        }),
    );

    const manga_category = await applyEach(
      body.manga_category ?? [],
      (row) => `${row.manga_id}:${row.category_name}`,
      async (row) => {
        // A tombstone only ever removes an assignment, so resolve the category instead of
        // creating it: `findOrCreateByName` here would resurrect a category deleted on
        // another device just to mark the assignment deleted, leaving an orphaned empty
        // category behind. No category means there is no assignment left to delete.
        const category = row.deleted_at
          ? await categoryRepository.getCategoryByName(row.category_name)
          : await categoryRepository.findOrCreateByName(row.category_name);

        if (!category) {
          return;
        }

        await userMangaCategoryRepository.applyIncoming(
          user_id,
          row.manga_id,
          category.id,
          row.deleted_at ? new Date(row.deleted_at) : null,
          new Date(row.updated_at),
        );
      },
    );

    const history = await applyEach(
      body.history ?? [],
      (row) => row.id,
      (row) =>
        historyRepository.applyIncoming(user_id, {
          id: row.id,
          source: row.source,
          manga_id: row.manga_id,
          manga_slug: row.manga_slug,
          source_manga_id: row.source_manga_id ?? null,
          title: row.title,
          thumbnail_url: row.thumbnail_url,
          chapter_id: row.chapter_id,
          read_at: new Date(row.read_at),
          last_read: new Date(row.last_read),
          pages_read: row.pages_read,
          time_read: row.time_read,
          deleted_at: row.deleted_at ? new Date(row.deleted_at) : null,
        }),
    );

    return { library, manga_state, chapter_state, manga_category, history };
  });

const syncService = { pull, push };

export default syncService;
