/**
 * Hand-rolled migration runner for the local SQLite DB — no Prisma here. Prisma is
 * reserved for apps/server, and a second generated client bundled into the Electron main
 * process would add complexity for a handful of CREATE TABLE statements.
 *
 * Each migration is a plain SQL string, applied in order inside one transaction, tracked
 * in `schema_migrations`. Never edit an applied migration — append a new one, same
 * convention as apps/server's Prisma migrations.
 */
import type { DatabaseSync } from 'node:sqlite';

interface Migration {
  version: number;
  name: string;
  sql: string;
  /** Set for a table rebuild. See runMigrations: the pragma cannot be set from inside the
   * migration's own SQL, because it is a no-op within a transaction. */
  disableForeignKeys?: boolean;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_local_schema',
    sql: `
      CREATE TABLE manga (
        id TEXT PRIMARY KEY,
        slug TEXT UNIQUE NOT NULL,
        title TEXT NOT NULL,
        author TEXT,
        source TEXT,
        thumbnail_url TEXT,
        artist TEXT,
        description TEXT,
        genres TEXT,
        status TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE chapter (
        id TEXT PRIMARY KEY,
        manga_id TEXT NOT NULL REFERENCES manga(id) ON DELETE CASCADE,
        url TEXT,
        name TEXT,
        scanlator TEXT,
        chapter_number REAL NOT NULL,
        release_date TEXT,
        page_count INTEGER,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_chapter_manga_id ON chapter(manga_id);

      -- Per-chapter read state. A separate table from "chapter" (rather than columns on
      -- it, like apps/server's shared chapter table does) so a future re-pull of catalog
      -- data (title/number/etc, which is shared/anonymous-equivalent) never has to worry
      -- about clobbering this device's own read progress in the same UPDATE.
      CREATE TABLE chapter_state (
        chapter_id TEXT PRIMARY KEY REFERENCES chapter(id) ON DELETE CASCADE,
        is_read INTEGER NOT NULL DEFAULT 0,
        is_bookmark INTEGER NOT NULL DEFAULT 0,
        last_page_read INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE manga_state (
        manga_id TEXT PRIMARY KEY REFERENCES manga(id) ON DELETE CASCADE,
        in_library INTEGER NOT NULL DEFAULT 0,
        is_bookmarked INTEGER NOT NULL DEFAULT 0,
        shelf_status TEXT,
        notification_read INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE history (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        manga_id TEXT,
        manga_slug TEXT NOT NULL,
        title TEXT,
        thumbnail_url TEXT,
        chapter_id TEXT,
        read_at TEXT NOT NULL,
        last_read TEXT NOT NULL,
        pages_read INTEGER NOT NULL DEFAULT 0,
        time_read INTEGER NOT NULL DEFAULT 0,
        deleted_at TEXT
      );
      CREATE INDEX idx_history_manga_slug ON history(manga_slug);

      CREATE TABLE category (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE manga_category (
        manga_id TEXT NOT NULL REFERENCES manga(id) ON DELETE CASCADE,
        category_id TEXT NOT NULL REFERENCES category(id) ON DELETE CASCADE,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (manga_id, category_id)
      );

      -- Per-domain sync cursors (Phase C). Present from the start so Phase C doesn't need
      -- its own migration just to add this bookkeeping table.
      CREATE TABLE sync_meta (
        domain TEXT PRIMARY KEY,
        last_pulled_at TEXT,
        last_pushed_at TEXT
      );
    `,
  },
  {
    version: 2,
    name: 'chapter_manga_id_nullable',
    disableForeignKeys: true,
    sql: `
      -- apps/server's chapter.manga_id is nullable on purpose: reading, marking and
      -- progress all work for a title that was never added to the library, keyed on
      -- source + slug (see the data-change guidance, "Nullable relations are
      -- deliberate"). Migration 1 made it NOT NULL, which forbids exactly that case —
      -- and since PRAGMA foreign_keys is ON, marking any chapter this database had not
      -- already seeded failed outright with a FOREIGN KEY constraint error instead of
      -- recording the read.
      --
      -- SQLite cannot relax a column constraint in place, so this is the standard
      -- rebuild: new table, copy, drop, rename. Only catalog data lives on this table —
      -- read state is in chapter_state, which is untouched.
      CREATE TABLE chapter_new (
        id TEXT PRIMARY KEY,
        manga_id TEXT REFERENCES manga(id) ON DELETE CASCADE,
        url TEXT,
        name TEXT,
        scanlator TEXT,
        chapter_number REAL NOT NULL,
        release_date TEXT,
        page_count INTEGER,
        updated_at TEXT NOT NULL
      );

      INSERT INTO chapter_new (id, manga_id, url, name, scanlator, chapter_number, release_date, page_count, updated_at)
        SELECT id, manga_id, url, name, scanlator, chapter_number, release_date, page_count, updated_at FROM chapter;

      DROP TABLE chapter;
      ALTER TABLE chapter_new RENAME TO chapter;
      CREATE INDEX idx_chapter_manga_id ON chapter(manga_id);
    `,
  },
  {
    version: 3,
    name: 'history_source_manga_id',
    sql: 'ALTER TABLE history ADD COLUMN source_manga_id TEXT;',
  },
  {
    version: 4,
    name: 'source_scoped_manga_slug',
    disableForeignKeys: true,
    sql: `
      CREATE TABLE manga_new (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        title TEXT NOT NULL,
        author TEXT,
        source TEXT,
        thumbnail_url TEXT,
        artist TEXT,
        description TEXT,
        genres TEXT,
        status TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE(source, slug)
      );
      INSERT INTO manga_new (id, slug, title, author, source, thumbnail_url, artist, description, genres, status, updated_at)
        SELECT id, slug, title, author, source, thumbnail_url, artist, description, genres, status, updated_at FROM manga;
      DROP TABLE manga;
      ALTER TABLE manga_new RENAME TO manga;
    `,
  },
];

function ensureMigrationsTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

export function runMigrations(db: DatabaseSync): void {
  ensureMigrationsTable(db);

  const appliedVersions = new Set(
    db
      .prepare('SELECT version FROM schema_migrations')
      .all()
      .map((row) => row.version as number),
  );

  // A database written by a newer build has tables this one knows nothing about. Opening
  // it anyway would read and write them with the wrong assumptions, so refuse before
  // touching anything.
  const latestKnown = Math.max(...MIGRATIONS.map((m) => m.version));
  const newest = Math.max(0, ...appliedVersions);
  if (newest > latestKnown) {
    throw new Error(
      `This local database was created by a newer version of Projekt Manga (schema ${newest}, this app supports up to ${latestKnown}). Update the app to open it.`,
    );
  }

  const pending = MIGRATIONS.filter((m) => !appliedVersions.has(m.version)).sort(
    (a, b) => a.version - b.version,
  );

  for (const migration of pending) {
    // SQLite's documented procedure for rebuilding a table (ALTER TABLE cannot relax a
    // column constraint) requires foreign keys to be off for the drop-and-rename, and
    // `PRAGMA foreign_keys` is a **no-op inside a transaction** — so it has to be set
    // here, outside BEGIN, rather than in the migration's own SQL where it would silently
    // do nothing. Getting this wrong is not cosmetic: chapter_state references chapter
    // ON DELETE CASCADE, so dropping the old table with enforcement on would take every
    // row of this device's read progress with it.
    if (migration.disableForeignKeys) {
      db.exec('PRAGMA foreign_keys = OFF;');
    }

    db.exec('BEGIN');
    try {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
      if (migration.disableForeignKeys) {
        // Checked before COMMIT so a rebuild that left a dangling reference rolls back
        // instead of being committed and only noticed afterwards.
        const violations = db.prepare('PRAGMA foreign_key_check').all();
        if (violations.length > 0) {
          throw new Error(
            `Migration ${migration.version} (${migration.name}) left ${violations.length} foreign key violation(s)`,
          );
        }
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    } finally {
      if (migration.disableForeignKeys) {
        db.exec('PRAGMA foreign_keys = ON;');
      }
    }
  }
}
