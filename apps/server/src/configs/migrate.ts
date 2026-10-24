import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

const execFileAsync = promisify(execFile);

/**
 * Applies pending schema migrations, with a backup that is restored if they fail.
 *
 * Hosted, a bad migration is one operator's problem on one server, with a backup they
 * control. In the desktop installer it runs on every user's machine at every update,
 * against a database nobody can inspect — so a migration that dies halfway must not leave
 * a stranger's library in a state only a developer could recover.
 *
 * SQLite is what makes this cheap: the whole database is one file, so "back it up" is a
 * file copy rather than a dump.
 *
 * Mirrors the shape of apps/desktop/src/main/db/migrate.ts, which does the same job for
 * the desktop's local cache — deliberately, so there is one recognisable pattern for
 * "migrate safely" in this codebase rather than two.
 */

export interface MigrationOutcome {
  /** False when the database is unusable and the app must not start against it. */
  ok: boolean;
  /** True when migrations actually ran (as opposed to there being nothing pending). */
  applied: boolean;
  /** Where the pre-migration copy was kept, when one was taken. */
  backupPath?: string;
  /** Why the pre-migration copy could not be made. */
  backupError?: string;
  /** An incomplete backup artifact that could not be removed after backup creation failed. */
  partialBackupPath?: string;
  /** Whether recovery restored the database, failed, or was not needed. */
  recovery?: { status: 'restored' | 'failed' | 'not-required'; error?: string };
  /** Where a failed database was preserved for diagnosis. */
  failedPath?: string;
  error?: string;
}

/** How many pre-migration backups to keep. Enough to step back through a bad release
 * without letting a library-sized file accumulate once per update forever. */
const KEEP_BACKUPS = 3;

/** SQLite keeps its journal beside the database in WAL mode; copying the main file alone
 * would produce a backup missing the most recent committed transactions. */
const SIDECARS = ['-wal', '-shm'];

/** Avoid a backup/CLI run on every hot-reload. Besides startup cost, copying WAL
 * sidecars while another server still has the same current database open is unsafe. */
function hasPendingMigrations(dbFile: string, cwd: string): boolean {
  const directory = path.join(cwd, 'prisma', 'migrations');
  if (!fs.existsSync(dbFile) || !fs.existsSync(directory)) return true;
  const available = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && fs.existsSync(path.join(directory, entry.name, 'migration.sql')),
    )
    .map((entry) => entry.name);
  if (available.length === 0) return true;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbFile, { readOnly: true });
    const applied = new Set(
      (
        db
          .prepare(
            'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
          )
          .all() as { migration_name: string }[]
      ).map((row) => row.migration_name),
    );
    return available.some((name) => !applied.has(name));
  } catch {
    // An absent ledger is a first-run database; a malformed one must go through Prisma's
    // own migration error path rather than being mistaken for an up-to-date schema.
    return true;
  } finally {
    db?.close();
  }
}

/**
 * Locates the Prisma CLI without depending on `npx` being on PATH.
 *
 * `npx prisma` is fine in development and wrong in an installer: a packaged app has no npm
 * on PATH, and under `ELECTRON_RUN_AS_NODE` there is no `npx` shim to find either. Running
 * the resolved CLI script with the current binary works in both, so the npx form is only a
 * fallback for a checkout where resolution somehow fails.
 *
 * `ELECTRON_RUN_AS_NODE` is set on the child (see the call site) so that when
 * `process.execPath` is the Electron binary it behaves as plain Node rather than trying to
 * boot a second app window.
 */
function resolvePrismaCli(
  dbFile: string,
  cwd: string,
): {
  command: string;
  args: string[];
  needsShell: boolean;
} {
  /**
   * Prisma 7 reads the datasource URL *only* from a config file — there is no `--url` flag
   * on `migrate deploy`. The repo's prisma.config.ts is TypeScript and unusable in a
   * packaged app with no tsx, so the installer stages a `.mjs` equivalent next to the
   * server (see apps/desktop/scripts/stage-installer.mjs) and it is pointed at explicitly
   * here. In development the file is absent and Prisma finds prisma.config.ts on its own.
   *
   * The staged config reads DATABASE_URL from the environment, which the call site sets to
   * exactly the database this process opened — so there is no second source of truth.
   */
  const stagedConfig = path.join(cwd, 'prisma.config.mjs');
  const deploy = ['migrate', 'deploy'];
  if (fs.existsSync(stagedConfig)) deploy.push('--config', stagedConfig);

  try {
    const require = createRequire(import.meta.url);
    // Deep path rather than the bare specifier: `prisma`'s own `exports` map points "." at
    // build/types.js, not the CLI, so `require.resolve('prisma')` fails.
    const cliPath = require.resolve('prisma/build/index.js');
    return { command: process.execPath, args: [cliPath, ...deploy], needsShell: false };
  } catch {
    return {
      command: 'npx',
      args: ['prisma', ...deploy],
      needsShell: process.platform === 'win32',
    };
  }
}

/** How long to keep retrying a migration that can't get the write lock. */
const LOCK_RETRY_ATTEMPTS = 6;
const LOCK_RETRY_DELAY_MS = 750;

/**
 * Runs `prisma migrate deploy`, retrying while the database is merely locked.
 *
 * "database is locked" is not a broken migration — it means something else currently holds
 * the write lock, and the migration never started. Treating it as a failure would restore
 * the backup and refuse to start over a condition that clears on its own in a moment. This
 * is reachable in practice: a still-running previous instance, or a developer's
 * `npm run dev:server` open on the same file.
 *
 * The schema engine holds its own connection and does not honour our `busy_timeout`, so
 * the wait has to happen out here rather than in the pragma.
 */
async function runMigrateDeploy(dbFile: string, cwd: string): Promise<void> {
  const cli = resolvePrismaCli(dbFile, cwd);
  let lastError: unknown;

  for (let attempt = 1; attempt <= LOCK_RETRY_ATTEMPTS; attempt++) {
    try {
      await execFileAsync(cli.command, cli.args, {
        cwd,
        env: { ...process.env, DATABASE_URL: `file:${dbFile}`, ELECTRON_RUN_AS_NODE: '1' },
        // Only the `npx` fallback needs a shell to be found on PATH; running a resolved
        // script through the current binary does not, and enabling it there would drag the
        // path through shell quoting for no reason.
        shell: cli.needsShell,
      });
      return;
    } catch (error) {
      lastError = error;
      const text = error instanceof Error ? `${error.message}` : String(error);
      const locked = /database is locked|SQLITE_BUSY/i.test(text);
      if (!locked || attempt === LOCK_RETRY_ATTEMPTS) throw error;

      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_DELAY_MS * attempt));
    }
  }

  throw lastError;
}

function copyDatabase(dbFile: string, destination: string): void {
  fs.copyFileSync(dbFile, destination);
  for (const suffix of SIDECARS) {
    const sidecar = `${dbFile}${suffix}`;
    if (fs.existsSync(sidecar)) fs.copyFileSync(sidecar, `${destination}${suffix}`);
  }
}

function restoreDatabase(backup: string, dbFile: string): void {
  fs.copyFileSync(backup, dbFile);
  for (const suffix of SIDECARS) {
    const from = `${backup}${suffix}`;
    const to = `${dbFile}${suffix}`;
    if (fs.existsSync(from)) fs.copyFileSync(from, to);
    else if (fs.existsSync(to)) fs.rmSync(to, { force: true });
  }
}

/** Removes all but the newest `KEEP_BACKUPS`. Sorted by name, which sorts by time because
 * the timestamp is the prefix. */
function pruneBackups(dir: string, base: string): void {
  const backups = fs
    .readdirSync(dir)
    .filter((name) => name.startsWith(`${base}.pre-`) && name.endsWith('.bak'))
    .sort();

  for (const stale of backups.slice(0, Math.max(0, backups.length - KEEP_BACKUPS))) {
    for (const suffix of ['', ...SIDECARS]) {
      fs.rmSync(path.join(dir, `${stale}${suffix}`), { force: true });
    }
  }
}

/**
 * Runs `prisma migrate deploy` behind a backup.
 *
 * `deploy`, never `dev`: `dev` can decide the database has drifted and offer to reset it,
 * which on a user's machine means silently destroying their library.
 */
export async function migrateWithBackup(
  dbFile: string,
  cwd: string,
  version = 'unknown',
): Promise<MigrationOutcome> {
  const dir = path.dirname(path.resolve(cwd, dbFile));
  const base = path.basename(dbFile);
  const resolved = path.resolve(cwd, dbFile);
  if (!hasPendingMigrations(resolved, cwd)) return { ok: true, applied: false };

  // A database that doesn't exist yet has nothing to lose and nothing to restore — this
  // is first run, where `migrate deploy` creates it.
  const isFirstRun = !fs.existsSync(resolved);
  let backupPath: string | undefined;

  if (!isFirstRun) {
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    backupPath = path.join(dir, `${base}.pre-${stamp}-${version}.bak`);
    try {
      copyDatabase(resolved, backupPath);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      let cleanupFailed = false;
      for (const suffix of ['', ...SIDECARS]) {
        try {
          fs.rmSync(`${backupPath}${suffix}`, { force: true });
        } catch {
          cleanupFailed = true;
        }
      }
      return {
        ok: false,
        applied: false,
        backupError: detail,
        partialBackupPath:
          cleanupFailed &&
          ['', ...SIDECARS].some((suffix) => fs.existsSync(`${backupPath}${suffix}`))
            ? backupPath
            : undefined,
        error: `Could not create the pre-migration backup at ${backupPath}: ${detail}`,
      };
    }
  }

  try {
    await runMigrateDeploy(dbFile, cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // A lock failure means Prisma never acquired a writer connection and could not
    // start the migration. Replacing a live database's WAL files here is more dangerous
    // than leaving the original untouched and asking the operator to stop the other API.
    if (/database is locked|SQLITE_BUSY/i.test(message)) {
      return {
        ok: false,
        applied: false,
        backupPath,
        recovery: backupPath ? { status: 'not-required' } : undefined,
        error: message,
      };
    }

    if (!backupPath) {
      // First run: there is no previous state to go back to, so the honest outcome is
      // "this install is not usable" rather than a restore that would restore nothing.
      return { ok: false, applied: false, error: message };
    }

    // Keep the broken database for diagnosis before overwriting it with the backup —
    // without this the evidence is destroyed by the recovery.
    let failedPath: string | undefined;
    try {
      const candidate = `${resolved}.failed-${Date.now()}`;
      fs.copyFileSync(resolved, candidate);
      failedPath = candidate;
    } catch {
      // Best effort; losing the forensic copy must not stop the restore.
    }

    try {
      restoreDatabase(backupPath, resolved);
      return {
        ok: false,
        applied: false,
        backupPath,
        failedPath,
        recovery: { status: 'restored' },
        error: message,
      };
    } catch (restoreError) {
      const detail = restoreError instanceof Error ? restoreError.message : String(restoreError);
      return {
        ok: false,
        applied: false,
        backupPath,
        failedPath,
        recovery: { status: 'failed', error: detail },
        error: `${message}; automatic database restore failed: ${detail}`,
      };
    }
  }

  // `integrity_check` is deliberately after the migration rather than before: a migration
  // that corrupts the file is exactly what this is looking for, and checking a database
  // that was already fine tells you nothing.
  const integrity = await checkIntegrity(resolved);
  if (!integrity.ok) {
    // Wrapped because the copy can still fail (permissions, a full disk, another process
    // holding the file). Letting that throw would replace a precise "integrity check
    // failed, here is your backup" with an opaque filesystem error.
    try {
      if (backupPath) restoreDatabase(backupPath, resolved);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        applied: false,
        backupPath,
        recovery: { status: 'failed', error: detail },
        error: `Database failed integrity_check and could not be restored automatically (${detail}). Your backup is at ${backupPath}.`,
      };
    }
    return {
      ok: false,
      applied: false,
      backupPath,
      recovery: backupPath ? { status: 'restored' } : undefined,
      error: `Database failed integrity_check after migrating: ${integrity.detail}`,
    };
  }

  if (backupPath) pruneBackups(dir, base);
  return { ok: true, applied: true, backupPath };
}

/** Runs `PRAGMA integrity_check`, which returns the single row "ok" on a healthy file. */
async function checkIntegrity(dbFile: string): Promise<{ ok: boolean; detail: string }> {
  // node:sqlite rather than a PrismaClient on the libSQL adapter: that adapter keeps the
  // OS file handle open after $disconnect(), which on Windows makes the restore below fail
  // with EPERM and keeps the database locked for the life of the process.
  // DatabaseSync releases the file as soon as close() returns.
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbFile, { readOnly: true });
    const rows = db.prepare('PRAGMA integrity_check').all() as Record<string, unknown>[];
    const first = String(Object.values(rows[0] ?? {})[0] ?? '');
    return { ok: first === 'ok', detail: first || 'no result' };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    db?.close();
  }
}
