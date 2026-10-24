import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaLibSql } from '@prisma/adapter-libsql';
import { PrismaClient } from '@prisma/client';

/**
 * Category name matching, against a real SQLite database rather than the prisma mock.
 *
 * This is the one behaviour where MariaDB and SQLite genuinely disagree and the difference
 * is silent: MariaDB's default collation matched an incoming "action" to a stored
 * "Action", SQLite's does not. A mock cannot prove which collation the real engine uses,
 * so this test opens an actual database — which the SQLite port makes cheap enough to do
 * in a unit test, since there is no server to start.
 *
 * The failure being guarded against is not a duplicate row. `addCategory` derives the
 * primary key from the lowercased name, so the create that followed a missed lookup
 * collided on the *id* and raised P2002 — breaking sync, which resolves categories by name
 * so that devices converge.
 */

// The global setup (tests/setup.ts) points every prisma import at the mock. This file
// needs the real client, so it opts out before importing anything that pulls it in.
vi.unmock('../src/configs/prisma.config.js');

let tmpDir: string;
let prisma: PrismaClient;

/** Applies the squashed initial migration to a fresh file. Reading the checked-in SQL
 * rather than calling `prisma migrate` keeps this a fast in-process test and asserts
 * against exactly the schema that ships. */
async function createSchema(dbPath: string): Promise<PrismaClient> {
  const migrationsDir = path.join(__dirname, '..', 'prisma', 'migrations');
  const dirs = fs
    .readdirSync(migrationsDir)
    .filter((entry) => fs.statSync(path.join(migrationsDir, entry)).isDirectory())
    .sort();

  const client = new PrismaClient({ adapter: new PrismaLibSql({ url: `file:${dbPath}` }) });

  for (const dir of dirs) {
    const sql = fs.readFileSync(path.join(migrationsDir, dir, 'migration.sql'), 'utf-8');
    for (const raw of sql.split(';')) {
      // Comment lines are stripped rather than used to skip the block: Prisma prefixes
      // each statement with `-- CreateTable`, so skipping anything starting with `--`
      // would discard the CREATE TABLE that follows it on the next line.
      const statement = raw
        .split(/\r?\n/)
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim();
      if (statement.length === 0) continue;
      await client.$executeRawUnsafe(statement);
    }
  }
  return client;
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'category-case-'));
  const dbPath = path.join(tmpDir, 'test.db').replace(/\\/g, '/');
  prisma = await createSchema(dbPath);
});

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

describe('category name matching under SQLite', () => {
  it('confirms SQLite really is case-sensitive on a unique text column', async () => {
    // The premise of the fix. If this ever fails, the workaround below is unnecessary.
    await prisma.category.create({ data: { id: 'shonen', name: 'Shonen' } });

    const exact = await prisma.category.findUnique({ where: { name: 'Shonen' } });
    const differentCase = await prisma.category.findUnique({ where: { name: 'shonen' } });

    expect(exact).not.toBeNull();
    expect(differentCase).toBeNull();
  });

  it('resolves a differently-cased name to the same category', async () => {
    const { canonicalCategoryId } = await import('../src/repositories/category.repository.js');

    await prisma.category.create({ data: { id: canonicalCategoryId('Action'), name: 'Action' } });

    // What findOrCreateByName now does: look up by the canonical id, not by name.
    const found = await prisma.category.findUnique({
      where: { id: canonicalCategoryId('action') },
    });

    expect(found).not.toBeNull();
    expect(found?.name).toBe('Action');
  });

  it('would have raised P2002 on the id, not created a duplicate', async () => {
    const { canonicalCategoryId } = await import('../src/repositories/category.repository.js');

    await prisma.category.create({ data: { id: canonicalCategoryId('Isekai'), name: 'Isekai' } });

    // The old code path: name lookup misses, so it creates — and collides on the primary
    // key, which is what broke sync rather than merely duplicating a row.
    await expect(
      prisma.category.create({ data: { id: canonicalCategoryId('isekai'), name: 'isekai' } }),
    ).rejects.toThrow();

    expect(await prisma.category.count({ where: { id: 'isekai' } })).toBe(1);
  });

  it('canonicalises spaces and surrounding whitespace consistently', async () => {
    const { canonicalCategoryId } = await import('../src/repositories/category.repository.js');

    expect(canonicalCategoryId('Slice Of Life')).toBe('slice-of-life');
    expect(canonicalCategoryId('  slice of life  ')).toBe('slice-of-life');
    expect(canonicalCategoryId('Sci   Fi')).toBe('sci-fi');
  });
});
