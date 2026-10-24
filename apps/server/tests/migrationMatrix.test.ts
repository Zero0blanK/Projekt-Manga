import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const migrationsPath = path.resolve(import.meta.dirname, '../prisma/migrations');
const migrations = fs
  .readdirSync(migrationsPath, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => ({
    name: entry.name,
    sql: fs.readFileSync(path.join(migrationsPath, entry.name, 'migration.sql'), 'utf8'),
  }))
  .sort((left, right) => left.name.localeCompare(right.name));

let temporaryDirectory: string;

function openDatabase(filePath: string): DatabaseSync {
  const database = new DatabaseSync(filePath);
  database.exec(`
    CREATE TABLE IF NOT EXISTS _prisma_migrations (
      migration_name TEXT PRIMARY KEY,
      finished_at TEXT,
      rolled_back_at TEXT
    );
  `);
  return database;
}

function applyMigration(database: DatabaseSync, migration: (typeof migrations)[number]): void {
  database.exec(migration.sql);
  database
    .prepare(
      'INSERT INTO _prisma_migrations (migration_name, finished_at) VALUES (?, CURRENT_TIMESTAMP)',
    )
    .run(migration.name);
}

function schemaSnapshot(database: DatabaseSync) {
  return database
    .prepare(
      `SELECT type, name, tbl_name, sql
       FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%'
       ORDER BY type, name`,
    )
    .all();
}

function seedRepresentativeLibraryRow(database: DatabaseSync): void {
  database
    .prepare(
      `INSERT INTO mangas
       (id, slug, title, author, source, thumbnail_url, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'migration-matrix-manga',
      'migration-matrix-slug',
      'Migration matrix fixture',
      'Fixture author',
      'fixture-source',
      'https://example.test/cover.jpg',
      '2026-10-11T00:00:00.000Z',
    );
}

afterEach(() => {
  if (temporaryDirectory) fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe('SQLite migration compatibility matrix', () => {
  it('upgrades every migration boundary to the fresh-install schema without losing library data', async () => {
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'projekt-manga-migration-matrix-'));
    const freshDatabase = openDatabase(path.join(temporaryDirectory, 'fresh.db'));
    for (const migration of migrations) applyMigration(freshDatabase, migration);
    const expectedSchema = schemaSnapshot(freshDatabase);
    freshDatabase.close();

    for (let startingBoundary = 0; startingBoundary < migrations.length; startingBoundary++) {
      // node:sqlite is synchronous; without a yield this test holds the worker's event loop
      // for minutes on a slow runner, and vitest's worker RPC times out ("onTaskUpdate").
      await new Promise((resolve) => setImmediate(resolve));
      const databasePath = path.join(temporaryDirectory, `upgrade-${startingBoundary}.db`);
      const database = openDatabase(databasePath);

      for (const migration of migrations.slice(0, startingBoundary + 1)) {
        applyMigration(database, migration);
      }
      seedRepresentativeLibraryRow(database);
      database.close();

      const upgraded = openDatabase(databasePath);
      for (const migration of migrations.slice(startingBoundary + 1)) {
        applyMigration(upgraded, migration);
      }

      expect(schemaSnapshot(upgraded), `schema from boundary ${startingBoundary}`).toEqual(
        expectedSchema,
      );
      expect(
        upgraded
          .prepare('SELECT id, slug, title, source FROM mangas WHERE id = ?')
          .get('migration-matrix-manga'),
      ).toEqual({
        id: 'migration-matrix-manga',
        slug: 'migration-matrix-slug',
        title: 'Migration matrix fixture',
        source: 'fixture-source',
      });
      upgraded.close();
    }
  }, 300_000); // Replays every migration boundary; slow under a full parallel test run, and
  // the Windows CI runner has taken ~2 minutes.
});
