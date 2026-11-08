import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Applies pending Prisma migrations to a SQLite file, in this process.
 *
 * This replaces running `prisma migrate deploy` as a child process. The Prisma CLI and its
 * tooling were about a third of the desktop installer's files, every one of them scanned by
 * antivirus on the first start after an update, only to run a few SQL files.
 *
 * It does what `migrate deploy` does for SQLite, and writes the same records, so a database
 * migrated here and one migrated by the CLI are interchangeable in either direction:
 *
 * - `_prisma_migrations` is created with Prisma's own definition if it is missing.
 * - A migration that started and never finished (not rolled back either) stops everything,
 *   as Prisma's P3009 does: applying later migrations on top of a half-applied one would
 *   compound the damage. It needs a person, and the backup taken before migrating.
 * - Each migration whose folder has no finished row is applied in folder-name order: a row
 *   is inserted with `started_at`, the script runs, then `finished_at` and
 *   `applied_steps_count = 1` are set. On failure the error goes into `logs` and the row is
 *   left unfinished, exactly as the CLI leaves it.
 * - `checksum` is the SHA-256 of the file's bytes, as Prisma computes it (no line-ending
 *   normalisation; a Windows checkout's CRLF file hashes differently, for Prisma too).
 *   Times are integer milliseconds and `id` is a v4 UUID, as Prisma writes them in SQLite.
 * - The script runs as written, outside a transaction, on a connection with foreign keys
 *   off, which is how Prisma's schema engine runs it. Prisma's table-redefinition migrations
 *   depend on that: `PRAGMA foreign_keys=OFF` does nothing inside a transaction.
 *
 * Safety comes from the caller (migrate.ts): a file copy is taken first and restored if
 * this throws, as it was around the CLI.
 */

/** Prisma's `_prisma_migrations` definition for SQLite, as `migrate deploy` creates it. */
const MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
    "id"                    TEXT PRIMARY KEY NOT NULL,
    "checksum"              TEXT NOT NULL,
    "finished_at"           DATETIME,
    "migration_name"        TEXT NOT NULL,
    "logs"                  TEXT,
    "rolled_back_at"        DATETIME,
    "started_at"            DATETIME NOT NULL DEFAULT current_timestamp,
    "applied_steps_count"   INTEGER UNSIGNED NOT NULL DEFAULT 0
)`;

/** How long a statement waits for another connection's write lock before failing. */
const BUSY_TIMEOUT_MS = 5000;

/**
 * A migration script that failed after it started, so some of its statements may have run.
 *
 * Distinct from an error before any migration began (a locked database, say): the caller
 * retries those, but must restore its backup after one of these.
 */
export class MigrationFailedError extends Error {
  constructor(
    readonly migration: string,
    cause: unknown,
  ) {
    super(
      `Migration ${migration} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = 'MigrationFailedError';
  }
}

export interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

/** The migration folders under `migrationsDir` that contain a migration.sql, in order. */
export function readMigrations(migrationsDir: string): MigrationFile[] {
  const lock = path.join(migrationsDir, 'migration_lock.toml');
  if (fs.existsSync(lock)) {
    const provider = /provider\s*=\s*"([^"]+)"/.exec(fs.readFileSync(lock, 'utf8'))?.[1];
    if (provider && provider !== 'sqlite') {
      throw new Error(
        `The migrations in ${migrationsDir} are for ${provider}, not SQLite (migration_lock.toml).`,
      );
    }
  }
  return fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && fs.existsSync(path.join(migrationsDir, entry.name, 'migration.sql')),
    )
    .map((entry) => entry.name)
    .sort()
    .map((name) => {
      const bytes = fs.readFileSync(path.join(migrationsDir, name, 'migration.sql'));
      return {
        name,
        sql: bytes.toString('utf8'),
        checksum: crypto.createHash('sha256').update(bytes).digest('hex'),
      };
    });
}

interface MigrationRow {
  migration_name: string;
  started_at: number | string | null;
  finished_at: number | string | null;
  rolled_back_at: number | string | null;
}

/** Names of the migrations applied so far: finished and not rolled back. */
function finishedMigrations(rows: MigrationRow[]): Set<string> {
  return new Set(
    rows
      .filter((row) => row.finished_at !== null && row.rolled_back_at === null)
      .map((row) => row.migration_name),
  );
}

export interface AppliedMigrations {
  /** The migrations this call applied, in order. Empty when nothing was pending. */
  applied: string[];
}

export function applyMigrations(dbFile: string, migrationsDir: string): AppliedMigrations {
  const migrations = readMigrations(migrationsDir);
  fs.mkdirSync(path.dirname(path.resolve(dbFile)), { recursive: true });
  const db = new DatabaseSync(dbFile, {
    enableForeignKeyConstraints: false,
    timeout: BUSY_TIMEOUT_MS,
  });
  try {
    db.exec(MIGRATIONS_TABLE);
    const rows = db
      .prepare(
        'SELECT migration_name, started_at, finished_at, rolled_back_at FROM _prisma_migrations',
      )
      .all() as unknown as MigrationRow[];

    const failed = rows.find((row) => row.finished_at === null && row.rolled_back_at === null);
    if (failed) {
      const started =
        typeof failed.started_at === 'number'
          ? new Date(failed.started_at).toISOString()
          : String(failed.started_at);
      throw new Error(
        `A previous migration failed and was never resolved, so no further migrations will be applied: ` +
          `"${failed.migration_name}" (started ${started}). Restore the pre-migration backup, or mark it ` +
          'rolled back once the database has been repaired.',
      );
    }

    const done = finishedMigrations(rows);
    const applied: string[] = [];
    const insert = db.prepare(
      `INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, applied_steps_count)
       VALUES (?, ?, ?, ?, 0)`,
    );
    const finish = db.prepare(
      'UPDATE _prisma_migrations SET finished_at = ?, applied_steps_count = 1 WHERE id = ?',
    );
    const recordFailure = db.prepare('UPDATE _prisma_migrations SET logs = ? WHERE id = ?');

    for (const migration of migrations) {
      if (done.has(migration.name)) continue;
      const id = crypto.randomUUID();
      insert.run(id, migration.checksum, migration.name, Date.now());
      try {
        db.exec(migration.sql);
      } catch (error) {
        const failure = new MigrationFailedError(migration.name, error);
        try {
          recordFailure.run(failure.message, id);
        } catch {
          // The original error is what matters; the database may be unusable by now.
        }
        throw failure;
      }
      finish.run(Date.now(), id);
      applied.push(migration.name);
    }
    return { applied };
  } finally {
    db.close();
  }
}
