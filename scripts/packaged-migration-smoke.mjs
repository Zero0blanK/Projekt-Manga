import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

// Run with the packaged resources/node executable so the CLI and native SQLite
// dependencies are checked in the same runtime used by the desktop supervisor.
const resources = path.resolve(process.argv[2] ?? '');
assert.ok(process.argv[2], 'Pass the packaged resources directory');
const expectedNode = path.join(
  resources,
  'node',
  process.platform === 'win32' ? 'node.exe' : 'node',
);
assert.equal(fs.realpathSync(process.execPath), fs.realpathSync(expectedNode));
const server = path.join(resources, 'server');
assert.ok(fs.existsSync(path.join(server, 'prisma.config.mjs')), 'Missing staged Prisma config');
const { migrateWithBackup } = await import(
  pathToFileURL(path.join(server, 'dist', 'configs', 'migrate.js')).href
);
const migrationsRoot = path.join(server, 'prisma', 'migrations');
const migrations = fs
  .readdirSync(migrationsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => ({
    name: entry.name,
    sql: fs.readFileSync(path.join(migrationsRoot, entry.name, 'migration.sql'), 'utf8'),
  }))
  .sort((a, b) => a.name.localeCompare(b.name));
const fixtures = fs.mkdtempSync(path.join(path.dirname(resources), 'migration-test-'));

function schema(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT type, name, tbl_name, sql FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%' AND name != '_prisma_migrations'
      ORDER BY type, name`,
      )
      .all();
  } finally {
    db.close();
  }
}

const freshFile = path.join(fixtures, 'fresh-test.db');
assert.equal((await migrateWithBackup(freshFile, server, 'packaged-smoke')).ok, true);
const expectedSchema = schema(freshFile);
assert.deepEqual(await migrateWithBackup(freshFile, server, 'packaged-smoke'), {
  ok: true,
  applied: false,
});

let upgradeBackup;
for (let prefix = 1; prefix < migrations.length; prefix++) {
  const file = path.join(fixtures, `prefix-${prefix}-test.db`);
  const db = new DatabaseSync(file);
  try {
    db.exec(`CREATE TABLE _prisma_migrations (
      id TEXT PRIMARY KEY NOT NULL, checksum TEXT NOT NULL,
      finished_at DATETIME, migration_name TEXT NOT NULL, logs TEXT,
      rolled_back_at DATETIME, started_at DATETIME NOT NULL DEFAULT current_timestamp,
      applied_steps_count INTEGER UNSIGNED NOT NULL DEFAULT 0
    )`);
    for (const migration of migrations.slice(0, prefix)) {
      db.exec(migration.sql);
      db.prepare(
        `INSERT INTO _prisma_migrations
        (id, checksum, migration_name, finished_at, applied_steps_count)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP, 1)`,
      ).run(
        crypto.randomUUID(),
        crypto.createHash('sha256').update(migration.sql).digest('hex'),
        migration.name,
      );
    }
    db.prepare(
      `INSERT INTO mangas (id, slug, title, author, source, thumbnail_url, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'preserved',
      'preserved',
      'Packaged migration fixture',
      'Fixture',
      'fixture',
      '',
      '2026-10-11T00:00:00.000Z',
    );
  } finally {
    db.close();
  }
  const outcome = await migrateWithBackup(file, server, 'packaged-smoke');
  assert.equal(outcome.ok, true, `prefix ${prefix}: ${outcome.error}`);
  assert.ok(outcome.backupPath && fs.existsSync(outcome.backupPath));
  upgradeBackup = outcome.backupPath;
  assert.deepEqual(schema(file), expectedSchema, `schema after prefix ${prefix}`);
  const upgraded = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(
      upgraded.prepare('SELECT title FROM mangas WHERE id = ?').get('preserved').title,
      'Packaged migration fixture',
    );
  } finally {
    upgraded.close();
  }
  assert.deepEqual(await migrateWithBackup(file, server, 'packaged-smoke'), {
    ok: true,
    applied: false,
  });
}
// Windows chmod exposes the file's read-only attribute. Exercise an actual OS
// write denial in the packaged runtime, alongside the unit fault-injection checks.
if (process.platform === 'win32') {
  assert.ok(upgradeBackup);
  const deniedFile = path.join(fixtures, 'readonly-test.db');
  fs.copyFileSync(upgradeBackup, deniedFile);
  const originalSchema = schema(deniedFile);
  fs.chmodSync(deniedFile, 0o444);
  try {
    const denied = await migrateWithBackup(deniedFile, server, 'packaged-smoke');
    assert.equal(denied.ok, false);
    assert.equal(denied.recovery?.status, 'failed');
    assert.ok(denied.backupPath && fs.existsSync(denied.backupPath));
    assert.deepEqual(schema(denied.backupPath), originalSchema);
    assert.deepEqual(schema(deniedFile), originalSchema);
  } finally {
    fs.chmodSync(deniedFile, 0o666);
  }
}
console.log(
  JSON.stringify({
    result: 'passed',
    runtime: process.version,
    platform: process.platform,
    arch: process.arch,
    migrationPrefixes: migrations.length - 1,
    freshInstall: true,
    restart: true,
    fixtures,
  }),
);
