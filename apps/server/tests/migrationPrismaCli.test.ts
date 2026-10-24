import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrateWithBackup } from '../src/configs/migrate.js';

const serverRoot = path.resolve(import.meta.dirname, '..');
const migrationsRoot = path.join(serverRoot, 'prisma', 'migrations');
const migrations = fs
  .readdirSync(migrationsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => ({
    name: entry.name,
    sql: fs.readFileSync(path.join(migrationsRoot, entry.name, 'migration.sql'), 'utf8'),
  }))
  .sort((a, b) => a.name.localeCompare(b.name));

let temporaryDirectory = '';

function openDatabase(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE _prisma_migrations (
      id TEXT PRIMARY KEY NOT NULL,
      checksum TEXT NOT NULL,
      finished_at DATETIME,
      migration_name TEXT NOT NULL,
      logs TEXT,
      rolled_back_at DATETIME,
      started_at DATETIME NOT NULL DEFAULT current_timestamp,
      applied_steps_count INTEGER UNSIGNED NOT NULL DEFAULT 0
    );
  `);
  return db;
}

function applyPrefix(file: string, completedCount: number): void {
  const db = openDatabase(file);
  for (const migration of migrations.slice(0, completedCount)) {
    db.exec(migration.sql);
    db.prepare(
      `INSERT INTO _prisma_migrations
       (id, checksum, finished_at, migration_name, started_at, applied_steps_count)
       VALUES (?, ?, CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP, 1)`,
    ).run(
      crypto.randomUUID(),
      crypto.createHash('sha256').update(migration.sql).digest('hex'),
      migration.name,
    );
  }
  if (completedCount > 0) {
    db.prepare(
      `INSERT INTO mangas
       (id, slug, title, author, source, thumbnail_url, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'cli-migration-preserve',
      'cli-migration-preserve',
      'Prisma CLI migration fixture',
      'Fixture author',
      'fixture-source',
      'https://example.test/cover.jpg',
      '2026-10-11T00:00:00.000Z',
    );
  }
  db.close();
}

function schemaSnapshot(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  const rows = db
    .prepare(
      `SELECT type, name, tbl_name, sql
       FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%' AND name != '_prisma_migrations'
       ORDER BY type, name`,
    )
    .all();
  db.close();
  return rows;
}

afterEach(async () => {
  if (!temporaryDirectory) return;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
      temporaryDirectory = '';
      return;
    } catch (error) {
      if (attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
});

describe('Prisma CLI migration compatibility', () => {
  it('deploys the real CLI from fresh install and every supported migration prefix', async () => {
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'projekt-manga-prisma-cli-'));
    const freshDatabase = path.join(temporaryDirectory, 'fresh.db');
    const fresh = await migrateWithBackup(freshDatabase, serverRoot, 'matrix-test');
    expect(fresh).toMatchObject({ ok: true, applied: true });
    const expectedSchema = schemaSnapshot(freshDatabase);

    for (let completedCount = 1; completedCount < migrations.length; completedCount++) {
      const file = path.join(temporaryDirectory, `prefix-${completedCount}.db`);
      applyPrefix(file, completedCount);

      const result = await migrateWithBackup(file, serverRoot, 'matrix-test');
      expect(result, `Prisma CLI from prefix ${completedCount}`).toMatchObject({
        ok: true,
        applied: true,
      });
      expect(schemaSnapshot(file), `schema from prefix ${completedCount}`).toEqual(expectedSchema);
      const db = new DatabaseSync(file, { readOnly: true });
      const preservedRow = db
        .prepare('SELECT id, title FROM mangas WHERE id = ?')
        .get('cli-migration-preserve');
      db.close();
      expect(preservedRow).toEqual({
        id: 'cli-migration-preserve',
        title: 'Prisma CLI migration fixture',
      });
    }
  }, 400_000); // Took 125s of the old 180s budget on the Windows CI runner.
});
