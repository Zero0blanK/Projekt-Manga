import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { migrateWithBackup } from '../src/configs/migrate.js';

/**
 * The server applies migrations in process (configs/applyMigrations.ts) rather than by
 * running `prisma migrate deploy`, so the installer need not ship the Prisma CLI. These tests
 * hold it to the real CLI, which stays a development dependency for exactly this:
 *
 * - from an empty database and from every earlier migration, the schema matches the CLI's;
 * - the `_prisma_migrations` rows match the CLI's field for field (bar ids and times);
 * - the two are interchangeable: the CLI accepts a database migrated in process, and the
 *   server continues one the CLI migrated.
 *
 * Every database is a temp file; DATABASE_URL is set explicitly for the CLI.
 */

const execFileAsync = promisify(execFile);
const serverRoot = path.resolve(import.meta.dirname, '..');
const migrationsRoot = path.join(serverRoot, 'prisma', 'migrations');
const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
const migrations = fs
  .readdirSync(migrationsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => ({
    name: entry.name,
    sql: fs.readFileSync(path.join(migrationsRoot, entry.name, 'migration.sql'), 'utf8'),
  }))
  .sort((a, b) => a.name.localeCompare(b.name));

let temporaryDirectory = '';

async function cli(args: string[], file: string) {
  return execFileAsync(process.execPath, [prismaCli, ...args], {
    cwd: serverRoot,
    env: { ...process.env, DATABASE_URL: `file:${file}` },
  });
}

/** Applies the first `count` migrations through the CLI, from a folder holding only those. */
async function cliPrefix(file: string, count: number): Promise<void> {
  const partial = path.join(temporaryDirectory, `cli-prefix-${count}`);
  fs.mkdirSync(path.join(partial, 'migrations'), { recursive: true });
  fs.copyFileSync(
    path.join(serverRoot, 'prisma', 'schema.prisma'),
    path.join(partial, 'schema.prisma'),
  );
  for (const migration of migrations.slice(0, count)) {
    fs.cpSync(
      path.join(migrationsRoot, migration.name),
      path.join(partial, 'migrations', migration.name),
      {
        recursive: true,
      },
    );
  }
  fs.copyFileSync(
    path.join(migrationsRoot, 'migration_lock.toml'),
    path.join(partial, 'migrations', 'migration_lock.toml'),
  );
  await cli(['migrate', 'deploy', '--schema', path.join(partial, 'schema.prisma')], file);
}

function seed(file: string): void {
  const db = new DatabaseSync(file);
  db.prepare(
    `INSERT INTO mangas (id, slug, title, author, source, thumbnail_url, updated_at)
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
  db.close();
}

function schemaSnapshot(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  const rows = db
    .prepare(
      `SELECT type, name, tbl_name, sql
       FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%'
       ORDER BY type, name`,
    )
    .all();
  db.close();
  return rows;
}

/** The migration records, without the fields that differ by run (ids and times). */
function records(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  const rows = (
    db.prepare('SELECT * FROM _prisma_migrations ORDER BY migration_name').all() as Record<
      string,
      unknown
    >[]
  ).map((row) => ({
    migration_name: row.migration_name,
    checksum: row.checksum,
    logs: row.logs,
    rolled_back_at: row.rolled_back_at,
    applied_steps_count: row.applied_steps_count,
    finished: typeof row.finished_at,
    started: typeof row.started_at,
  }));
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

describe('in-process migrations match prisma migrate deploy', () => {
  it('from an empty database, and every migration record is the one Prisma writes', async () => {
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'projekt-manga-prisma-cli-'));
    const byCli = path.join(temporaryDirectory, 'cli.db');
    const inProcess = path.join(temporaryDirectory, 'server.db');

    await cli(['migrate', 'deploy'], byCli);
    const result = await migrateWithBackup(inProcess, serverRoot, 'cli-compat-test');

    expect(result).toMatchObject({ ok: true, applied: true });
    expect(schemaSnapshot(inProcess)).toEqual(schemaSnapshot(byCli));
    expect(records(inProcess)).toEqual(records(byCli));
    expect(records(inProcess)).toHaveLength(migrations.length);
    for (const record of records(inProcess)) {
      const sql = fs.readFileSync(
        path.join(migrationsRoot, String(record.migration_name), 'migration.sql'),
      );
      expect(record.checksum).toBe(crypto.createHash('sha256').update(sql).digest('hex'));
    }
  }, 120_000);

  it('continues a database the CLI migrated part way, from every migration', async () => {
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'projekt-manga-prisma-cli-'));
    const reference = path.join(temporaryDirectory, 'reference.db');
    await cli(['migrate', 'deploy'], reference);
    const expectedSchema = schemaSnapshot(reference);
    const expectedRecords = records(reference);

    for (let completed = 1; completed < migrations.length; completed++) {
      const file = path.join(temporaryDirectory, `prefix-${completed}.db`);
      await cliPrefix(file, completed);
      seed(file);

      const result = await migrateWithBackup(file, serverRoot, 'cli-compat-test');

      expect(result, `from migration ${completed}`).toMatchObject({ ok: true, applied: true });
      expect(schemaSnapshot(file), `schema from migration ${completed}`).toEqual(expectedSchema);
      expect(records(file), `records from migration ${completed}`).toEqual(expectedRecords);
      const db = new DatabaseSync(file, { readOnly: true });
      expect(
        db.prepare('SELECT title FROM mangas WHERE id = ?').get('cli-migration-preserve'),
      ).toEqual({
        title: 'Prisma CLI migration fixture',
      });
      db.close();
    }
  }, 600_000); // The CLI is spawned once per migration; slow on the Windows CI runner.

  it('leaves a database the CLI accepts as up to date, and can continue on its own', async () => {
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'projekt-manga-prisma-cli-'));
    const file = path.join(temporaryDirectory, 'server.db');
    await migrateWithBackup(file, serverRoot, 'cli-compat-test');

    const status = await cli(['migrate', 'status'], file);
    expect(status.stdout).toMatch(/Database schema is up to date/);
    const deploy = await cli(['migrate', 'deploy'], file);
    expect(deploy.stdout).toMatch(/No pending migrations to apply/);
    expect(records(file)).toHaveLength(migrations.length);
  }, 120_000);
});
