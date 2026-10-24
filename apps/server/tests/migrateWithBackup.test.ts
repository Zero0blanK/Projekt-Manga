import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * The migration safety net, exercised on its failure path.
 *
 * A happy-path-only test here would be close to worthless: the whole point of this code is
 * what happens when `prisma migrate deploy` dies halfway on a machine nobody can inspect.
 * So `execFile` is stubbed to fail, and the assertions are about what is left on disk
 * afterwards — the user's database back as it was, and the broken one preserved.
 */

const execFileImpl = vi.fn();

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    // promisify() reads this symbol to find the promise-returning form, so the stub has
    // to carry it or `promisify(execFile)` wraps the callback form and never resolves.
    execFile: Object.assign((...args: unknown[]) => execFileImpl(...args), {
      [Symbol.for('nodejs.util.promisify.custom')]: (...args: unknown[]) => execFileImpl(...args),
    }),
  };
});

const { migrateWithBackup } = await import('../src/configs/migrate.js');

const committedMigrationsPath = path.resolve(import.meta.dirname, '../prisma/migrations');
const committedMigrations = fs
  .readdirSync(committedMigrationsPath, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => ({
    name: entry.name,
    sql: fs.readFileSync(path.join(committedMigrationsPath, entry.name, 'migration.sql'), 'utf8'),
    statements: fs
      .readFileSync(path.join(committedMigrationsPath, entry.name, 'migration.sql'), 'utf8')
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean),
  }))
  .sort((left, right) => left.name.localeCompare(right.name));

function migrationSchema(database: DatabaseSync) {
  return database
    .prepare(
      `SELECT type, name, tbl_name, sql
       FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%'
       ORDER BY type, name`,
    )
    .all();
}

/** Creates a genuine SQLite file, so `PRAGMA integrity_check` on the success path has
 * something real to check. */
async function createRealDatabase(file: string): Promise<void> {
  const { PrismaLibSql } = await import('@prisma/adapter-libsql');
  const { PrismaClient } = await import('@prisma/client');
  const client = new PrismaClient({
    adapter: new PrismaLibSql({ url: `file:${file.replace(/\\/g, '/')}` }),
  });
  await client.$executeRawUnsafe('CREATE TABLE IF NOT EXISTS probe (id INTEGER PRIMARY KEY)');
  await client.$disconnect();
}

function countBackups(): number {
  return fs.readdirSync(tmpDir).filter((n) => n.includes('.pre-') && n.endsWith('.bak')).length;
}

let tmpDir: string;
let dbFile: string;

const ORIGINAL_CONTENT = 'ORIGINAL DATABASE BYTES';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-backup-'));
  dbFile = path.join(tmpDir, 'projektmanga.db');
  execFileImpl.mockReset();
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* Windows may still hold a handle; the OS reaps the temp dir either way. */
  }
});

describe('migrateWithBackup', () => {
  it('restores the original database after interruption at every committed SQL statement boundary', async () => {
    let boundaryCount = 0;

    for (const [migrationIndex, migration] of committedMigrations.entries()) {
      expect(migration.statements.length, migration.name).toBeGreaterThan(0);

      for (let failAfter = 1; failAfter <= migration.statements.length; failAfter++) {
        const boundaryDir = path.join(tmpDir, `boundary-${boundaryCount++}`);
        const migrationsDir = path.join(boundaryDir, 'prisma', 'migrations');
        const targetDir = path.join(migrationsDir, migration.name);
        const targetDb = path.join(boundaryDir, 'projektmanga.db');
        fs.mkdirSync(targetDir, { recursive: true });
        fs.writeFileSync(path.join(targetDir, 'migration.sql'), migration.sql);

        const original = new DatabaseSync(targetDb);
        original.exec(`
          CREATE TABLE _prisma_migrations (
            migration_name TEXT PRIMARY KEY,
            finished_at TEXT,
            rolled_back_at TEXT
          );
          CREATE TABLE boundary_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
          INSERT INTO boundary_probe (id, value) VALUES (1, 'preserved');
        `);
        for (const earlier of committedMigrations.slice(0, migrationIndex)) {
          original.exec(earlier.sql);
          original
            .prepare(
              'INSERT INTO _prisma_migrations (migration_name, finished_at) VALUES (?, CURRENT_TIMESTAMP)',
            )
            .run(earlier.name);
        }
        const expectedSchema = migrationSchema(original);
        original.close();

        execFileImpl.mockImplementation(async () => {
          const interrupted = new DatabaseSync(targetDb);
          for (const statement of migration.statements.slice(0, failAfter)) {
            interrupted.exec(statement);
          }
          interrupted.close();
          throw new Error(`Injected interruption after ${failAfter} statements`);
        });

        const result = await migrateWithBackup(targetDb, boundaryDir, 'statement-boundary-test');
        expect(result.ok, `${migration.name} after statement ${failAfter}`).toBe(false);
        expect(result.failedPath, `${migration.name} after statement ${failAfter}`).toBeDefined();

        const recovered = new DatabaseSync(targetDb, { readOnly: true });
        expect(
          migrationSchema(recovered),
          `${migration.name} after statement ${failAfter}`,
        ).toEqual(expectedSchema);
        expect(recovered.prepare('SELECT value FROM boundary_probe WHERE id = 1').get()).toEqual({
          value: 'preserved',
        });
        recovered.close();
      }
    }

    expect(boundaryCount).toBe(
      committedMigrations.reduce((sum, item) => sum + item.statements.length, 0),
    );
  }, 120_000);

  it('creates a fresh database and recognizes it as migrated after a restart', async () => {
    const migrationName = '20261010000000_fixture';
    const migrationDirectory = path.join(tmpDir, 'prisma', 'migrations', migrationName);
    fs.mkdirSync(migrationDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(migrationDirectory, 'migration.sql'),
      'CREATE TABLE probe (id INTEGER PRIMARY KEY);',
    );

    execFileImpl.mockImplementation(async () => {
      const db = new DatabaseSync(dbFile);
      db.exec(`
        CREATE TABLE probe (id INTEGER PRIMARY KEY);
        CREATE TABLE _prisma_migrations (
          migration_name TEXT,
          finished_at TEXT,
          rolled_back_at TEXT
        );
      `);
      db.prepare('INSERT INTO _prisma_migrations VALUES (?, ?, NULL)').run(
        migrationName,
        '2026-10-10T00:00:00.000Z',
      );
      db.close();
      return { stdout: '', stderr: '' };
    });

    const firstStart = await migrateWithBackup(dbFile, tmpDir, '1.0.0');
    const restart = await migrateWithBackup(dbFile, tmpDir, '1.0.0');

    expect(firstStart).toMatchObject({ ok: true, applied: true });
    expect(firstStart.backupPath).toBeUndefined();
    expect(restart).toEqual({ ok: true, applied: false });
    expect(execFileImpl).toHaveBeenCalledTimes(1);
  });

  it('uses the staged Prisma config and exact database path in packaged mode', async () => {
    const migrationDirectory = path.join(tmpDir, 'prisma', 'migrations', '20261010000000_fixture');
    fs.mkdirSync(migrationDirectory, { recursive: true });
    fs.writeFileSync(path.join(migrationDirectory, 'migration.sql'), 'SELECT 1;');
    const stagedConfig = path.join(tmpDir, 'prisma.config.mjs');
    fs.writeFileSync(stagedConfig, 'export default {};');
    await createRealDatabase(dbFile);
    execFileImpl.mockResolvedValue({ stdout: '', stderr: '' });

    const result = await migrateWithBackup(dbFile, tmpDir, '1.0.0');
    const [, args, options] = execFileImpl.mock.calls[0] as [
      string,
      string[],
      { cwd: string; env: NodeJS.ProcessEnv },
    ];

    expect(result.ok).toBe(true);
    expect(args).toContain('--config');
    expect(args).toContain(stagedConfig);
    expect(options.cwd).toBe(tmpDir);
    expect(options.env.DATABASE_URL).toBe(`file:${dbFile}`);
    expect(options.env.ELECTRON_RUN_AS_NODE).toBe('1');
  });

  it('does not run packaged migrations when the pre-migration backup cannot be written', async () => {
    const migrationDirectory = path.join(tmpDir, 'prisma', 'migrations', '20261010000000_fixture');
    fs.mkdirSync(migrationDirectory, { recursive: true });
    fs.writeFileSync(path.join(migrationDirectory, 'migration.sql'), 'SELECT 1;');
    fs.writeFileSync(path.join(tmpDir, 'prisma.config.mjs'), 'export default {};');
    await createRealDatabase(dbFile);

    const originalCopyFileSync = fs.copyFileSync;
    const copyFile = vi
      .spyOn(fs, 'copyFileSync')
      .mockImplementation((source, destination, ...rest) => {
        if (String(destination).endsWith('.bak')) {
          const error = new Error('permission denied') as NodeJS.ErrnoException;
          error.code = 'EACCES';
          throw error;
        }
        return originalCopyFileSync(source, destination, ...rest);
      });

    try {
      const result = await migrateWithBackup(dbFile, tmpDir, '1.0.0');
      expect(result).toMatchObject({
        ok: false,
        applied: false,
        backupError: 'permission denied',
      });
      expect(result.backupPath).toBeUndefined();
      expect(result.error).toContain('Could not create the pre-migration backup');
    } finally {
      copyFile.mockRestore();
    }

    expect(execFileImpl).not.toHaveBeenCalled();
    const database = new DatabaseSync(dbFile, { readOnly: true });
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name = 'probe'").get()).toEqual({
      name: 'probe',
    });
    database.close();
    expect(countBackups()).toBe(0);
  });

  it('reports a failed restore and retains the valid backup after a permission error', async () => {
    await createRealDatabase(dbFile);
    execFileImpl.mockImplementation(async () => {
      fs.writeFileSync(dbFile, 'PARTIALLY MIGRATED');
      throw new Error('P3009 migration failed');
    });

    const originalCopyFileSync = fs.copyFileSync;
    const copyFile = vi
      .spyOn(fs, 'copyFileSync')
      .mockImplementation((source, destination, ...rest) => {
        if (String(destination) === dbFile) {
          const error = new Error('permission denied during restore') as NodeJS.ErrnoException;
          error.code = 'EACCES';
          throw error;
        }
        return originalCopyFileSync(source, destination, ...rest);
      });

    let result;
    try {
      result = await migrateWithBackup(dbFile, tmpDir, '1.0.0');
    } finally {
      copyFile.mockRestore();
    }

    expect(result).toMatchObject({
      ok: false,
      recovery: { status: 'failed', error: 'permission denied during restore' },
    });
    expect(result!.error).toContain('automatic database restore failed');
    expect(result!.backupPath).toBeDefined();
    expect(fs.existsSync(result!.backupPath!)).toBe(true);
    const backup = new DatabaseSync(result!.backupPath!, { readOnly: true });
    expect(backup.prepare("SELECT name FROM sqlite_master WHERE name = 'probe'").get()).toEqual({
      name: 'probe',
    });
    backup.close();
    expect(fs.readFileSync(dbFile, 'utf8')).toBe('PARTIALLY MIGRATED');
  });

  it('recovers the previous schema and can apply the migration on a later startup', async () => {
    const previousMigration = '20260929000000_previous';
    const nextMigration = '20261010000000_fixture';
    const migrationDirectory = path.join(tmpDir, 'prisma', 'migrations', nextMigration);
    fs.mkdirSync(migrationDirectory, { recursive: true });
    const migrationSql = `
      CREATE TABLE fixture_migrated (id INTEGER PRIMARY KEY);
      CREATE INDEX fixture_migrated_id_idx ON fixture_migrated(id);
    `;
    fs.writeFileSync(path.join(migrationDirectory, 'migration.sql'), migrationSql);
    const initial = new DatabaseSync(dbFile);
    initial.exec(`
      CREATE TABLE probe (id INTEGER PRIMARY KEY);
      CREATE TABLE _prisma_migrations (
        migration_name TEXT,
        finished_at TEXT,
        rolled_back_at TEXT
      );
    `);
    initial
      .prepare('INSERT INTO _prisma_migrations VALUES (?, ?, NULL)')
      .run(previousMigration, '2026-09-29T00:00:00.000Z');
    initial.close();

    execFileImpl.mockImplementation(async () => {
      if (execFileImpl.mock.calls.length === 1) {
        const partiallyMigrated = new DatabaseSync(dbFile);
        partiallyMigrated.exec('CREATE TABLE fixture_migrated (id INTEGER PRIMARY KEY);');
        partiallyMigrated.close();
        throw new Error('P3009 interrupted migration');
      }
      const recovered = new DatabaseSync(dbFile);
      recovered.exec(migrationSql);
      recovered
        .prepare('INSERT INTO _prisma_migrations VALUES (?, ?, NULL)')
        .run(nextMigration, '2026-10-10T00:00:00.000Z');
      recovered.close();
      return { stdout: '', stderr: '' };
    });

    const interrupted = await migrateWithBackup(dbFile, tmpDir, '1.0.0');
    expect(interrupted.ok).toBe(false);
    expect(interrupted.failedPath).toBeDefined();
    const restored = new DatabaseSync(dbFile, { readOnly: true });
    expect(restored.prepare('SELECT migration_name FROM _prisma_migrations').all()).toEqual([
      { migration_name: previousMigration },
    ]);
    expect(
      restored
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get('fixture_migrated'),
    ).toBeUndefined();
    restored.close();
    const failedDatabase = new DatabaseSync(interrupted.failedPath!, { readOnly: true });
    expect(
      failedDatabase
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get('fixture_migrated'),
    ).toEqual({ name: 'fixture_migrated' });
    failedDatabase.close();

    const recovered = await migrateWithBackup(dbFile, tmpDir, '1.0.0');

    expect(recovered).toMatchObject({ ok: true, applied: true });
    expect(execFileImpl).toHaveBeenCalledTimes(2);
    const upgraded = new DatabaseSync(dbFile, { readOnly: true });
    expect(
      upgraded
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get('fixture_migrated_id_idx'),
    ).toEqual({ name: 'fixture_migrated_id_idx' });
    upgraded.close();
  });

  it('skips backup and CLI when every migration is already applied', async () => {
    const directory = path.join(tmpDir, 'prisma', 'migrations', '20260929000000_example');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'migration.sql'), 'CREATE TABLE example (id INTEGER);');
    const db = new DatabaseSync(dbFile);
    db.exec(
      `CREATE TABLE _prisma_migrations (migration_name TEXT, finished_at TEXT, rolled_back_at TEXT)`,
    );
    db.prepare(`INSERT INTO _prisma_migrations VALUES (?, ?, NULL)`).run(
      '20260929000000_example',
      '2026-09-29T00:00:00.000Z',
    );
    db.close();

    const result = await migrateWithBackup(dbFile, tmpDir, '1.0.0');
    expect(result).toEqual({ ok: true, applied: false });
    expect(execFileImpl).not.toHaveBeenCalled();
    expect(countBackups()).toBe(0);
  });
  it('restores the previous database when the migration fails', async () => {
    fs.writeFileSync(dbFile, ORIGINAL_CONTENT);

    execFileImpl.mockImplementation(async () => {
      // Simulate a migration that got far enough to damage the file before dying.
      fs.writeFileSync(dbFile, 'HALF-MIGRATED GARBAGE');
      throw new Error('P3009 migrate found failed migration');
    });

    const result = await migrateWithBackup(dbFile, tmpDir, '1.2.3');

    expect(result.ok).toBe(false);
    expect(result.error).toContain('P3009');
    // The user's database is back exactly as it was.
    expect(fs.readFileSync(dbFile, 'utf-8')).toBe(ORIGINAL_CONTENT);
    // The broken one is preserved rather than destroyed by the recovery.
    expect(result.failedPath).toBeDefined();
    expect(fs.readFileSync(result.failedPath!, 'utf-8')).toBe('HALF-MIGRATED GARBAGE');
  });

  it('reports failure without restoring on a first run, where there is nothing to restore', async () => {
    execFileImpl.mockRejectedValue(new Error('cannot create database'));

    const result = await migrateWithBackup(dbFile, tmpDir, '1.2.3');

    expect(result.ok).toBe(false);
    expect(result.backupPath).toBeUndefined();
    expect(result.failedPath).toBeUndefined();
  });

  it('copies the WAL sidecar alongside the database', async () => {
    fs.writeFileSync(dbFile, ORIGINAL_CONTENT);
    fs.writeFileSync(`${dbFile}-wal`, 'PENDING TRANSACTIONS');

    execFileImpl.mockImplementation(async () => {
      fs.writeFileSync(dbFile, 'BROKEN');
      fs.writeFileSync(`${dbFile}-wal`, 'BROKEN WAL');
      throw new Error('boom');
    });

    const result = await migrateWithBackup(dbFile, tmpDir, '1.0.0');

    expect(result.ok).toBe(false);
    // Restoring the main file but not the WAL would silently lose whatever was only
    // committed in the journal — the reason SIDECARS exists.
    expect(fs.readFileSync(`${dbFile}-wal`, 'utf-8')).toBe('PENDING TRANSACTIONS');
  });

  it('retries a locked database instead of declaring the migration failed', async () => {
    await createRealDatabase(dbFile);

    // "database is locked" means the migration never started — something else holds the
    // write lock. Restoring and refusing to start over that would be wrong.
    let attempts = 0;
    execFileImpl.mockImplementation(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('SQLite database error\ndatabase is locked');
      return { stdout: '', stderr: '' };
    });

    const result = await migrateWithBackup(dbFile, tmpDir, '1.0.0');

    expect(attempts).toBe(3);
    expect(result.ok).toBe(true);
    expect(result.failedPath).toBeUndefined();
  });

  it('does not retry a genuine migration error', async () => {
    fs.writeFileSync(dbFile, ORIGINAL_CONTENT);

    let attempts = 0;
    execFileImpl.mockImplementation(async () => {
      attempts += 1;
      throw new Error('P3009 migrate found failed migration');
    });

    const result = await migrateWithBackup(dbFile, tmpDir, '1.0.0');

    // A broken migration is not going to fix itself; retrying only delays the report.
    expect(attempts).toBe(1);
    expect(result.ok).toBe(false);
  });

  it('keeps backups on the failure path — they are what recovery depends on', async () => {
    fs.writeFileSync(dbFile, ORIGINAL_CONTENT);
    for (let i = 1; i <= 5; i++) {
      fs.writeFileSync(path.join(tmpDir, `projektmanga.db.pre-2020-01-0${i}-old.bak`), 'old');
    }

    execFileImpl.mockRejectedValue(new Error('nope'));
    await migrateWithBackup(dbFile, tmpDir, '1.0.0');

    expect(countBackups()).toBeGreaterThanOrEqual(6);
  });

  it('prunes to the newest few after a migration that succeeds', async () => {
    // A *real* SQLite file, because the success path runs PRAGMA integrity_check — which
    // rejects the placeholder bytes the other tests use, so this is the one case that
    // cannot be faked.
    await createRealDatabase(dbFile);
    for (let i = 1; i <= 5; i++) {
      fs.writeFileSync(path.join(tmpDir, `projektmanga.db.pre-2020-01-0${i}-old.bak`), 'old');
    }

    // Migration itself is a no-op: what is under test is the bookkeeping around it.
    execFileImpl.mockResolvedValue({ stdout: '', stderr: '' });

    const result = await migrateWithBackup(dbFile, tmpDir, '2.0.0');

    expect(result.ok).toBe(true);
    expect(result.applied).toBe(true);
    // 5 stale + 1 just taken, trimmed to KEEP_BACKUPS.
    expect(countBackups()).toBe(3);
    // The one just taken survives — pruning oldest-first must never drop the newest.
    expect(fs.existsSync(result.backupPath!)).toBe(true);
  });
});
