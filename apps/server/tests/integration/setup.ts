import { beforeEach, afterAll, vi } from 'vitest';
// DATABASE_URL must be supplied explicitly. Never load the developer's .env here:
// integration tests truncate every table in the selected database.
import prisma from '../../src/configs/prisma.config.js';

// Database integration tests verify persistence, not outbound cover downloads. Manga
// creation queues a background thumbnail fetch that would otherwise call fixture URLs.
vi.mock('../../src/workers/thumbnailSync.js', () => ({
  default: { enqueue: vi.fn(), isQueued: vi.fn(() => false) },
}));

/**
 * Refuses to run against anything that isn't obviously a throwaway database.
 *
 * `truncateAll` below deletes every row in every table. The database it targets comes from
 * `DATABASE_URL`. A bare `npm run test:integration` must not fall back to the app's
 * development database, so the check below refuses to run without an explicit disposable
 * target.
 *
 * A name containing "test" or "ci" is the opt-in. CI sets `file:./data/ci-test.db`.
 */
function assertDisposableDatabase(): void {
  const url = process.env.DATABASE_URL ?? '';
  const file = url.replace(/^file:/, '');

  if (!/test|ci/i.test(file)) {
    throw new Error(
      `Refusing to run integration tests against "${url}" — these truncate every table.\n` +
        'Point DATABASE_URL at a disposable database whose name contains "test", e.g.\n' +
        '  DATABASE_URL="file:./data/ci-test.db" npm run test:integration --workspace=@projekt-manga/server\n' +
        '(and apply migrations to it first with `prisma migrate deploy`).',
    );
  }
}

assertDisposableDatabase();

/**
 * Child tables before the parents they reference.
 *
 * That ordering is what makes plain `DELETE`s legal without disabling foreign keys —
 * which matters because the MySQL trick this used to rely on has no SQLite equivalent:
 * `SET FOREIGN_KEY_CHECKS` does not exist, and `PRAGMA foreign_keys` is a **no-op inside a
 * transaction**, so wrapping the deletes the way the MariaDB version did would silently
 * enforce constraints anyway.
 */
const TABLES = [
  'restore_jobs',
  // Account overlay tables — children of both `users` and the shared tables.
  'user_chapter_state',
  'user_manga_category',
  'user_manga_state',
  'user_library',
  'sessions',
  'devices',
  'tracker_links',
  'tracker_accounts',
  'users',
  // Shared/anonymous tables.
  'caches',
  'downloads',
  'histories',
  'manga_categories',
  'manga_library',
  'update_logs',
  'chapters',
  'manga_details',
  'mangas',
  'categories',
  'installed_extensions',
  'extension_repositories',
];

/**
 * Empties every table between tests so each starts from a known, empty database — real
 * Prisma client, real SQLite file, no mocked data.
 *
 * `DELETE FROM` rather than `TRUNCATE`: SQLite has no TRUNCATE statement at all.
 */
export async function truncateAll(): Promise<void> {
  for (const table of TABLES) {
    await prisma.$executeRawUnsafe(`DELETE FROM "${table}"`);
  }
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});
