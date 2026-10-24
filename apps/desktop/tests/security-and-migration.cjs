const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { databaseFileName } = require('../dist/main/db/database-name.js');
const { runMigrations } = require('../dist/main/db/migrate.js');
const { requireSecureAccountTransport } = require('../dist/main/secure-transport.js');
const { DEFAULT_API_URL, resolveApiUrl } = require('../dist/shared/config.js');

test('desktop API URL resolves in development without an override', () => {
  const previous = process.env.PROJEKT_MANGA_API_URL;
  try {
    delete process.env.PROJEKT_MANGA_API_URL;
    assert.equal(resolveApiUrl(), DEFAULT_API_URL);
  } finally {
    if (previous === undefined) delete process.env.PROJEKT_MANGA_API_URL;
    else process.env.PROJEKT_MANGA_API_URL = previous;
  }
});

test('account cache filenames are distinct and do not mount the legacy mixed cache', () => {
  const anonymous = databaseFileName(null);
  const first = databaseFileName('account-a');
  const second = databaseFileName('account-b');
  assert.notEqual(first, second);
  assert.notEqual(first, anonymous);
  assert.notEqual(second, anonymous);
  assert.notEqual(anonymous, 'local.db');
  assert.ok(!first.includes('account-a'));
});

test('authenticated transport accepts HTTPS or loopback HTTP only', () => {
  assert.doesNotThrow(() => requireSecureAccountTransport('https://example.test/api'));
  assert.doesNotThrow(() => requireSecureAccountTransport('http://127.0.0.1:4000/api'));
  assert.throws(() => requireSecureAccountTransport('http://192.168.1.2:4000/api'), /HTTPS/);
  assert.throws(() => requireSecureAccountTransport('http://example.test/api'), /HTTPS/);
});

test('local migrations preserve history and permit source-scoped duplicate slugs', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db);
    db.prepare(
      'INSERT INTO manga (id, slug, title, source, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('a', '42', 'Title A', 'source-a', new Date().toISOString());
    db.prepare(
      'INSERT INTO manga (id, slug, title, source, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('b', '42', 'Title B', 'source-b', new Date().toISOString());
    db.prepare(
      'INSERT INTO history (id, source, manga_slug, source_manga_id, read_at, last_read) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('h', 'source-b', '42', 'native-b', new Date().toISOString(), new Date().toISOString());
    assert.equal(
      db.prepare('SELECT source_manga_id FROM history WHERE id = ?').get('h').source_manga_id,
      'native-b',
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM manga WHERE slug = ?').get('42').count,
      2,
    );
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
  }
});

test('upgrading the legacy slug constraint preserves child records', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES (1, 'initial_local_schema', '2026-01-01');
      INSERT INTO schema_migrations VALUES (2, 'chapter_manga_id_nullable', '2026-01-01');
      INSERT INTO schema_migrations VALUES (3, 'history_source_manga_id', '2026-01-01');
      CREATE TABLE manga (
        id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL, author TEXT,
        source TEXT, thumbnail_url TEXT, artist TEXT, description TEXT, genres TEXT,
        status TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE chapter (id TEXT PRIMARY KEY, manga_id TEXT REFERENCES manga(id) ON DELETE CASCADE);
      INSERT INTO manga (id, slug, title, source, updated_at) VALUES ('a', '42', 'Title A', 'source-a', '2026-01-01');
      INSERT INTO chapter (id, manga_id) VALUES ('chapter-a', 'a');
    `);
    runMigrations(db);
    assert.deepEqual(
      db
        .prepare('SELECT id, manga_id FROM chapter')
        .all()
        .map((row) => ({ ...row })),
      [{ id: 'chapter-a', manga_id: 'a' }],
    );
    db.prepare(
      'INSERT INTO manga (id, slug, title, source, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('b', '42', 'Title B', 'source-b', new Date().toISOString());
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
  }
});
