import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaLibSql } from '@prisma/adapter-libsql';
import { PrismaClient } from '@prisma/client';

/**
 * Category ownership and name matching, against a real SQLite database rather than the
 * prisma mock.
 *
 * Two things here only a real engine can prove. SQLite's default collation is
 * case-sensitive, so matching has to go through the canonical `key`. And its unique indexes
 * treat NULLs as distinct, so the anonymous list needs the migration's partial index, while
 * the per-account copying in that migration has to leave every assignment on a category of
 * the right owner.
 */

// The global setup (tests/setup.ts) points every prisma import at the mock. This file
// needs the real client, so it opts out before importing anything that pulls it in.
vi.unmock('../src/configs/prisma.config.js');

const CATEGORY_MIGRATION = '20261105000000_per_account_categories';

let tmpDir: string;
let prisma: PrismaClient;

/** Runs one checked-in migration. Reading the SQL rather than calling `prisma migrate` keeps
 * this a fast in-process test and asserts against exactly the schema that ships. */
async function applyMigration(client: PrismaClient, dir: string) {
  const file = path.join(__dirname, '..', 'prisma', 'migrations', dir, 'migration.sql');
  for (const raw of fs.readFileSync(file, 'utf-8').split(';')) {
    // Comment lines are stripped rather than used to skip the block: Prisma prefixes each
    // statement with `-- CreateTable`, so skipping anything starting with `--` would
    // discard the CREATE TABLE that follows it on the next line.
    const statement = raw
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .trim();
    if (statement.length > 0) await client.$executeRawUnsafe(statement);
  }
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'category-case-'));
  const dbPath = path.join(tmpDir, 'test.db').replace(/\\/g, '/');
  prisma = new PrismaClient({ adapter: new PrismaLibSql({ url: `file:${dbPath}` }) });

  const migrationsDir = path.join(__dirname, '..', 'prisma', 'migrations');
  const dirs = fs
    .readdirSync(migrationsDir)
    .filter((entry) => fs.statSync(path.join(migrationsDir, entry)).isDirectory())
    .sort();
  const split = dirs.indexOf(CATEGORY_MIGRATION);
  for (const dir of dirs.slice(0, split)) await applyMigration(prisma, dir);

  // A server as it was just before categories became per-account: one shared list, used by
  // the anonymous library and two accounts, plus one category nobody has used.
  const run = (sql: string) => prisma.$executeRawUnsafe(sql);
  for (const id of ['ann', 'bob']) {
    await run(
      `INSERT INTO users (id, email, password_hash, updated_at) VALUES ('${id}', '${id}@x.test', 'h', CURRENT_TIMESTAMP)`,
    );
  }
  await run(
    `INSERT INTO mangas (id, slug, title, author, source, thumbnail_url, updated_at) VALUES ('m1', 'one', 'One', 'a', 's', 't', CURRENT_TIMESTAMP)`,
  );
  await run(
    `INSERT INTO categories (id, name, updated_at) VALUES ('action', 'Action', CURRENT_TIMESTAMP), ('empty', 'Empty', CURRENT_TIMESTAMP)`,
  );
  await run(`INSERT INTO manga_categories (manga_id, category_id) VALUES ('m1', 'action')`);
  for (const [id, user] of [
    ['a1', 'ann'],
    ['b1', 'bob'],
  ]) {
    await run(
      `INSERT INTO user_manga_category (id, user_id, manga_id, category_id, updated_at) VALUES ('${id}', '${user}', 'm1', 'action', CURRENT_TIMESTAMP)`,
    );
  }

  for (const dir of dirs.slice(split)) await applyMigration(prisma, dir);
  // Replays every migration statement through Prisma: ~1s locally, but 9–17s on the Windows
  // CI runner while the migration-matrix tests compete for its CPU.
}, 60_000);

afterAll(async () => {
  await prisma?.$disconnect();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Windows keeps the database file handle open briefly after $disconnect (the WAL and
    // shm sidecars in particular), so the delete races it and throws EPERM. Failing the
    // suite over an undeleted temp directory the OS will reap anyway would be worse than
    // leaving it — the assertions above have already run.
  }
});

describe('the per-account categories migration', () => {
  it('keeps the existing list as the anonymous one, with its ids', async () => {
    const anonymous = await prisma.category.findMany({
      where: { user_id: null },
      orderBy: { id: 'asc' },
    });

    expect(anonymous.map((c) => [c.id, c.key, c.name])).toEqual([
      ['action', 'action', 'Action'],
      ['empty', 'empty', 'Empty'],
    ]);
    expect(await prisma.manga_category.count({ where: { category_id: 'action' } })).toBe(1);
  });

  it('gives each account a private copy of what it uses, and nothing else', async () => {
    for (const user_id of ['ann', 'bob']) {
      const own = await prisma.category.findMany({ where: { user_id } });
      expect(own.map((c) => c.name)).toEqual(['Action']);
      expect(own[0].id).not.toBe('action');

      const assignment = await prisma.user_manga_category.findFirstOrThrow({ where: { user_id } });
      expect(assignment.category_id).toBe(own[0].id);
    }
  });
});

describe('category ownership', () => {
  it('lets two owners use one name', async () => {
    await prisma.category.create({ data: { user_id: 'ann', key: 'isekai', name: 'Isekai' } });
    await prisma.category.create({ data: { user_id: 'bob', key: 'isekai', name: 'isekai' } });
    await prisma.category.create({ data: { key: 'isekai', name: 'Isekai' } });

    expect(await prisma.category.count({ where: { key: 'isekai' } })).toBe(3);
  });

  it('refuses a duplicate within an account', async () => {
    await prisma.category.create({ data: { user_id: 'ann', key: 'drama', name: 'Drama' } });

    await expect(
      prisma.category.create({ data: { user_id: 'ann', key: 'drama', name: 'DRAMA' } }),
    ).rejects.toThrow();
  });

  it('refuses a duplicate in the anonymous list', async () => {
    await prisma.category.create({ data: { key: 'comedy', name: 'Comedy' } });

    await expect(
      prisma.category.create({ data: { key: 'comedy', name: 'COMEDY' } }),
    ).rejects.toThrow();
  });

  it('removes an account’s categories with the account', async () => {
    await prisma.user.create({
      data: { id: 'gone', email: 'gone@x.test', password_hash: 'h' },
    });
    await prisma.category.create({ data: { user_id: 'gone', key: 'x', name: 'X' } });

    await prisma.user.delete({ where: { id: 'gone' } });

    expect(await prisma.category.count({ where: { user_id: 'gone' } })).toBe(0);
  });
});

describe('category name matching under SQLite', () => {
  it('confirms SQLite really is case-sensitive on a text column', async () => {
    // The premise of `key`. If this ever fails, the column is unnecessary.
    await prisma.category.create({ data: { user_id: 'ann', key: 'shonen', name: 'Shonen' } });

    const differentCase = await prisma.category.findFirst({
      where: { user_id: 'ann', name: 'shonen' },
    });

    expect(differentCase).toBeNull();
  });

  it('resolves a differently-cased name to the same category', async () => {
    const { canonicalCategoryKey } = await import('../src/repositories/category.repository.js');

    await prisma.category.create({ data: { user_id: 'bob', key: 'shojo', name: 'Shojo' } });

    const found = await prisma.category.findFirst({
      where: { user_id: 'bob', key: canonicalCategoryKey('SHOJO') },
    });

    expect(found?.name).toBe('Shojo');
  });

  it('canonicalises spaces and surrounding whitespace consistently', async () => {
    const { canonicalCategoryKey } = await import('../src/repositories/category.repository.js');

    expect(canonicalCategoryKey('Slice Of Life')).toBe('slice-of-life');
    expect(canonicalCategoryKey('  slice of life  ')).toBe('slice-of-life');
    expect(canonicalCategoryKey('Sci   Fi')).toBe('sci-fi');
  });
});
