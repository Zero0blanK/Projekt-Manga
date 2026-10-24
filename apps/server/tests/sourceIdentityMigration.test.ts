import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

describe('source identity migrations', () => {
  it('preserves an existing title and permits another source to use the same slug', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(
        'CREATE TABLE mangas (id TEXT PRIMARY KEY, source TEXT NOT NULL, slug TEXT NOT NULL)',
      );
      db.exec('CREATE UNIQUE INDEX mangas_slug_key ON mangas(slug)');
      db.prepare('INSERT INTO mangas (id, source, slug) VALUES (?, ?, ?)').run(
        'a',
        'source-a',
        '42',
      );

      const migration = readFileSync(
        new URL(
          '../prisma/migrations/20260928000001_source_scoped_manga_slug/migration.sql',
          import.meta.url,
        ),
        'utf8',
      );
      db.exec(migration);
      db.prepare('INSERT INTO mangas (id, source, slug) VALUES (?, ?, ?)').run(
        'b',
        'source-b',
        '42',
      );

      expect(db.prepare('SELECT id FROM mangas WHERE slug = ? ORDER BY id').all('42')).toEqual([
        { id: 'a' },
        { id: 'b' },
      ]);
      expect(() =>
        db
          .prepare('INSERT INTO mangas (id, source, slug) VALUES (?, ?, ?)')
          .run('c', 'source-a', '42'),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('adds a nullable native source ID without altering old history rows', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('CREATE TABLE histories (id TEXT PRIMARY KEY, manga_slug TEXT NOT NULL)');
      db.exec("INSERT INTO histories (id, manga_slug) VALUES ('old', 'slug')");
      const migration = readFileSync(
        new URL(
          '../prisma/migrations/20260928000000_history_source_manga_id/migration.sql',
          import.meta.url,
        ),
        'utf8',
      );
      db.exec(migration);
      expect(
        db.prepare('SELECT manga_slug, source_manga_id FROM histories WHERE id = ?').get('old'),
      ).toEqual({
        manga_slug: 'slug',
        source_manga_id: null,
      });
    } finally {
      db.close();
    }
  });
});
