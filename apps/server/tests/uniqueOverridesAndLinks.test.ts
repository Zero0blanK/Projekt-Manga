import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaLibSql } from '@prisma/adapter-libsql';
import { PrismaClient } from '@prisma/client';

/**
 * The migration that makes overrides and links unique, on a real SQLite file: it has to
 * settle duplicates that already exist, and SQLite's NULL handling is the reason the
 * anonymous identity needs indexes of its own.
 */

vi.unmock('../src/configs/prisma.config.js');

const MIGRATION = '20261105020000_unique_overrides_and_links';
const migrations = path.join(__dirname, '..', 'prisma', 'migrations');

let tmpDir: string;
let prisma: PrismaClient;

async function apply(dir: string) {
  const sql = fs.readFileSync(path.join(migrations, dir, 'migration.sql'), 'utf-8');
  for (const raw of sql.split(';')) {
    const statement = raw
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .trim();
    if (statement) await prisma.$executeRawUnsafe(statement);
  }
}

const override = (id: string, user: string, title: string, cover: string, at: string) =>
  `INSERT INTO manga_overrides (id, manga_id, user_id, title, cover_path, updated_at)
   VALUES ('${id}', 'm1', ${user}, ${title}, ${cover}, '${at}')`;
const link = (id: string, user: string, primary: string, priority: number) =>
  `INSERT INTO manga_links (id, user_id, primary_id, linked_id, priority)
   VALUES ('${id}', ${user}, '${primary}', 'm3', ${priority})`;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unique-overrides-'));
  const url = `file:${path.join(tmpDir, 'test.db').replace(/\\/g, '/')}`;
  prisma = new PrismaClient({ adapter: new PrismaLibSql({ url }) });

  const dirs = fs
    .readdirSync(migrations)
    .filter((entry) => fs.statSync(path.join(migrations, entry)).isDirectory())
    .sort();
  const split = dirs.indexOf(MIGRATION);
  for (const dir of dirs.slice(0, split)) await apply(dir);

  const run = (sql: string) => prisma.$executeRawUnsafe(sql);
  await run(
    `INSERT INTO users (id, email, password_hash, updated_at) VALUES ('ann', 'a@x.test', 'h', CURRENT_TIMESTAMP)`,
  );
  for (const id of ['m1', 'm2', 'm3']) {
    await run(
      `INSERT INTO mangas (id, slug, title, author, source, thumbnail_url, updated_at) VALUES ('${id}', '${id}', 'T', 'a', 's', 't', CURRENT_TIMESTAMP)`,
    );
  }
  // Duplicates for an account and for the anonymous identity.
  await run(override('old', "'ann'", "'Old'", "'/cache-assets/c.png'", '2026-01-01T00:00:00.000Z'));
  await run(override('new', "'ann'", "'New'", 'NULL', '2026-02-01T00:00:00.000Z'));
  await run(override('anon-old', 'NULL', "'A1'", 'NULL', '2026-01-01T00:00:00.000Z'));
  await run(override('anon-new', 'NULL', "'A2'", 'NULL', '2026-02-01T00:00:00.000Z'));
  await run(link('later', "'ann'", 'm1', 5));
  await run(link('first', "'ann'", 'm2', 0));
  await run(link('anon-later', 'NULL', 'm1', 5));
  await run(link('anon-first', 'NULL', 'm2', 0));

  for (const dir of dirs.slice(split)) await apply(dir);
}, 60_000);

afterAll(async () => {
  await prisma?.$disconnect();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Windows holds the file briefly after $disconnect; the OS reaps the temp directory.
  }
});

describe('settling existing duplicates', () => {
  it('keeps the newest override, with the custom cover only an older one had', async () => {
    const rows = await prisma.manga_override.findMany({ where: { user_id: 'ann' } });

    expect(rows.map((row) => [row.id, row.title, row.cover_path])).toEqual([
      ['new', 'New', '/cache-assets/c.png'],
    ]);
  });

  it('settles the anonymous identity too', async () => {
    const rows = await prisma.manga_override.findMany({ where: { user_id: null } });

    expect(rows.map((row) => row.id)).toEqual(['anon-new']);
  });

  it('keeps a linked title under its highest-priority primary', async () => {
    const rows = await prisma.manga_link.findMany({ orderBy: { id: 'asc' } });

    expect(rows.map((row) => row.id)).toEqual(['anon-first', 'first']);
  });
});

describe('the unique indexes', () => {
  it('refuse a second override for an identity', async () => {
    await expect(
      prisma.manga_override.create({ data: { manga_id: 'm1', user_id: 'ann', title: 'x' } }),
    ).rejects.toThrow();
    await expect(
      prisma.manga_override.create({ data: { manga_id: 'm1', title: 'x' } }),
    ).rejects.toThrow();
  });

  it('refuse a second primary for a linked title', async () => {
    await expect(
      prisma.manga_link.create({ data: { user_id: 'ann', primary_id: 'm1', linked_id: 'm3' } }),
    ).rejects.toThrow();
    await expect(
      prisma.manga_link.create({ data: { primary_id: 'm1', linked_id: 'm3' } }),
    ).rejects.toThrow();
  });

  it('leave separate identities alone', async () => {
    await prisma.manga_override.create({ data: { manga_id: 'm2', user_id: 'ann', title: 'x' } });
    await prisma.manga_override.create({ data: { manga_id: 'm2', title: 'x' } });

    expect(await prisma.manga_override.count({ where: { manga_id: 'm2' } })).toBe(2);
  });
});
