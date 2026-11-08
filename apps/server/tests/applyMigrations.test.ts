import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  applyMigrations,
  MigrationFailedError,
  readMigrations,
} from '../src/configs/applyMigrations.js';

/**
 * The in-process replacement for `prisma migrate deploy`. migrationPrismaCli.test.ts checks
 * it against the real CLI; these cover its rules on small fixtures.
 */

let tmpDir: string;
let migrationsDir: string;
let dbFile: string;

function addMigration(name: string, sql: string | Buffer): void {
  fs.mkdirSync(path.join(migrationsDir, name), { recursive: true });
  fs.writeFileSync(path.join(migrationsDir, name, 'migration.sql'), sql);
}

function rows(file = dbFile) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db
      .prepare('SELECT * FROM _prisma_migrations ORDER BY started_at, migration_name')
      .all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

function tables(file = dbFile): string[] {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
        name: string;
      }[]
    ).map((row) => row.name);
  } finally {
    db.close();
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-migrations-'));
  migrationsDir = path.join(tmpDir, 'migrations');
  fs.mkdirSync(migrationsDir);
  dbFile = path.join(tmpDir, 'data', 'library.db');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('applyMigrations', () => {
  it('creates the database and writes the records Prisma writes', () => {
    addMigration('20260101000000_one', 'CREATE TABLE one (id INTEGER PRIMARY KEY);');
    addMigration('20260102000000_two', 'CREATE TABLE two (id INTEGER PRIMARY KEY);');
    const before = Date.now();

    expect(applyMigrations(dbFile, migrationsDir)).toEqual({
      applied: ['20260101000000_one', '20260102000000_two'],
    });

    expect(tables()).toEqual(['_prisma_migrations', 'one', 'two']);
    const records = rows();
    expect(records).toHaveLength(2);
    for (const [index, name] of ['20260101000000_one', '20260102000000_two'].entries()) {
      const record = records[index];
      const sql = fs.readFileSync(path.join(migrationsDir, name, 'migration.sql'));
      expect(record.migration_name).toBe(name);
      expect(record.checksum).toBe(crypto.createHash('sha256').update(sql).digest('hex'));
      expect(record.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(record.applied_steps_count).toBe(1);
      expect(record.logs).toBeNull();
      expect(record.rolled_back_at).toBeNull();
      // Integer milliseconds, as Prisma stores them in SQLite.
      expect(typeof record.started_at).toBe('number');
      expect(record.started_at as number).toBeGreaterThanOrEqual(before);
      expect(record.finished_at as number).toBeGreaterThanOrEqual(record.started_at as number);
    }
  });

  it('applies only what is pending, in folder-name order', () => {
    addMigration('20260101000000_one', 'CREATE TABLE one (id INTEGER PRIMARY KEY);');
    applyMigrations(dbFile, migrationsDir);
    addMigration('20260103000000_three', 'ALTER TABLE two ADD COLUMN note TEXT;');
    addMigration('20260102000000_two', 'CREATE TABLE two (id INTEGER PRIMARY KEY);');

    expect(applyMigrations(dbFile, migrationsDir).applied).toEqual([
      '20260102000000_two',
      '20260103000000_three',
    ]);
    expect(applyMigrations(dbFile, migrationsDir).applied).toEqual([]);
    expect(rows().map((row) => row.migration_name)).toEqual([
      '20260101000000_one',
      '20260102000000_two',
      '20260103000000_three',
    ]);
  });

  it('records a failed script and then refuses to apply anything more', () => {
    addMigration('20260101000000_one', 'CREATE TABLE one (id INTEGER PRIMARY KEY);');
    addMigration(
      '20260102000000_broken',
      'CREATE TABLE half (id INTEGER PRIMARY KEY);\nINSERT INTO missing_table VALUES (1);',
    );
    addMigration('20260103000000_after', 'CREATE TABLE after_broken (id INTEGER);');

    expect(() => applyMigrations(dbFile, migrationsDir)).toThrow(MigrationFailedError);

    const failed = rows().find((row) => row.migration_name === '20260102000000_broken')!;
    expect(failed.finished_at).toBeNull();
    expect(failed.applied_steps_count).toBe(0);
    expect(String(failed.logs)).toMatch(/no such table: missing_table/);
    // Like Prisma, statements before the failure stay; the caller's backup undoes them.
    expect(tables()).toContain('half');
    expect(tables()).not.toContain('after_broken');

    // An unresolved failure blocks everything after it (Prisma's P3009).
    expect(() => applyMigrations(dbFile, migrationsDir)).toThrow(
      /no further migrations will be applied: "20260102000000_broken"/,
    );
    expect(tables()).not.toContain('after_broken');
  });

  it('applies a migration again once its failed attempt is marked rolled back', () => {
    addMigration('20260101000000_flaky', 'CREATE TABLE flaky (id INTEGER PRIMARY KEY);');
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    const db = new DatabaseSync(dbFile);
    db.exec(`CREATE TABLE "_prisma_migrations" (
      "id" TEXT PRIMARY KEY NOT NULL, "checksum" TEXT NOT NULL, "finished_at" DATETIME,
      "migration_name" TEXT NOT NULL, "logs" TEXT, "rolled_back_at" DATETIME,
      "started_at" DATETIME NOT NULL DEFAULT current_timestamp,
      "applied_steps_count" INTEGER UNSIGNED NOT NULL DEFAULT 0)`);
    db.prepare(
      `INSERT INTO _prisma_migrations (id, checksum, migration_name, logs, rolled_back_at, started_at)
       VALUES ('old', 'x', '20260101000000_flaky', 'failed', 1, 1)`,
    ).run();
    db.close();

    expect(applyMigrations(dbFile, migrationsDir).applied).toEqual(['20260101000000_flaky']);
    expect(tables()).toContain('flaky');
  });

  it('hashes the bytes on disk, line endings included, as Prisma does', () => {
    const crlf = Buffer.from('CREATE TABLE one (id INTEGER PRIMARY KEY);\r\n');
    addMigration('20260101000000_one', crlf);

    const [migration] = readMigrations(migrationsDir);

    expect(migration.checksum).toBe(crypto.createHash('sha256').update(crlf).digest('hex'));
  });

  it('runs scripts with foreign keys off, so table rebuilds keep their rows', () => {
    // Prisma's redefine-table pattern. With foreign keys on, dropping the parent would
    // cascade and delete the child's rows.
    addMigration(
      '20260101000000_init',
      `CREATE TABLE parent (id INTEGER PRIMARY KEY);
       CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id) ON DELETE CASCADE);
       INSERT INTO parent VALUES (1);
       INSERT INTO child VALUES (1, 1);`,
    );
    addMigration(
      '20260102000000_redefine',
      `PRAGMA defer_foreign_keys=ON;
       PRAGMA foreign_keys=OFF;
       CREATE TABLE new_parent (id INTEGER PRIMARY KEY, name TEXT);
       INSERT INTO new_parent (id) SELECT id FROM parent;
       DROP TABLE parent;
       ALTER TABLE new_parent RENAME TO parent;
       PRAGMA foreign_keys=ON;
       PRAGMA defer_foreign_keys=OFF;`,
    );

    applyMigrations(dbFile, migrationsDir);

    const db = new DatabaseSync(dbFile, { readOnly: true });
    expect(db.prepare('SELECT COUNT(*) AS n FROM child').get()).toEqual({ n: 1 });
    db.close();
  });

  it('refuses migrations written for another database', () => {
    fs.writeFileSync(path.join(migrationsDir, 'migration_lock.toml'), 'provider = "postgresql"\n');
    addMigration('20260101000000_one', 'CREATE TABLE one (id INTEGER PRIMARY KEY);');

    expect(() => applyMigrations(dbFile, migrationsDir)).toThrow(/postgresql, not SQLite/);
    expect(fs.existsSync(dbFile)).toBe(false);
  });
});
