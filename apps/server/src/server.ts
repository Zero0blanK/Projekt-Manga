// Must stay the first import: loads .env and validates it before anything that reads it
// is evaluated, so a bad or missing database config says so at startup instead of
// surfacing ten seconds later as a pool timeout inside an unrelated query.
import './configs/bootstrap.js';
import { loadEnv } from './configs/env.js';
import app from './app.js';
import { disposeAllSandboxedSources } from './services/sandboxedSourceRegistry.service.js';
import trackerService from './services/tracker.service.js';
import downloadWorker from './workers/download.worker.js';
import extensionRepositoryService from './services/extensionRepository.service.js';
import cacheService from './services/cache.service.js';
import { applySqlitePragmas } from './configs/prisma.config.js';
import { migrateWithBackup } from './configs/migrate.js';
import { resolveDatabaseConfig } from './configs/env.js';
import { recoverRestoreJobs } from './services/restore.service.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const env = loadEnv();

/** How often installed sources are checked for updates. Sources change their markup on a
 * scale of days, so a 6-hour cadence is far more often than needed while staying cheap —
 * one small JSON fetch per repository. */
const EXTENSION_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Delay before the first check. Startup is already doing migrations, source loading and
 * download recovery; a repository fetch racing all of that buys nothing. */
const EXTENSION_UPDATE_INITIAL_DELAY_MS = 30_000;

/**
 * Keeps installed source extensions current without an app update.
 *
 * Entirely best-effort and never awaited: an unreachable repository must not delay or fail
 * startup, which is why this schedules rather than blocking `main()`. `checkForUpdates`
 * already isolates per-extension failures; this only has to stop one bad cycle from
 * killing the timer.
 */
function startExtensionUpdateChecks(): void {
  const run = async () => {
    try {
      const { checked, updated, failed } = await extensionRepositoryService.checkForUpdates();
      if (updated.length > 0) {
        console.log(`[Extensions] Updated ${updated.length} of ${checked}: ${updated.join(', ')}`);
      }
      for (const failure of failed) {
        console.warn(`[Extensions] Update check failed for ${failure.source_key}:`, failure.reason);
      }
    } catch (error) {
      console.warn('[Extensions] Update check could not run:', error);
    }
  };

  // unref() so a pending timer never holds the process open on shutdown.
  setTimeout(() => void run(), EXTENSION_UPDATE_INITIAL_DELAY_MS).unref();
  setInterval(() => void run(), EXTENSION_UPDATE_INTERVAL_MS).unref();
}

/**
 * Applies pending migrations before the server accepts a request.
 *
 * The same backup-backed migration path runs for development and packaged starts.
 * Skipping it would let Prisma open a fresh SQLite file before it has any tables,
 * yielding unrelated worker errors instead of a usable first run. Operators who manage
 * migrations externally may explicitly set PROJEKT_MANGA_AUTO_MIGRATE=0.
 *
 * Exits rather than continuing on failure. The migration helper reports whether it
 * restored the previous database; if it could not, the backup path and failure are logged
 * for operator recovery. Serving against a potentially partial schema could corrupt data
 * more thoroughly than refusing to start.
 */
async function runStartupMigrations(): Promise<void> {
  if (process.env.PROJEKT_MANGA_AUTO_MIGRATE === '0') return;

  // The database path is relative to the working directory, exactly as the runtime client
  // resolves it; the migrations always live beside this file's package. Using cwd for both
  // would make a start from any other folder treat "no migrations found" as pending work.
  const file = path.resolve(resolveDatabaseConfig(env).file);
  const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (!fs.existsSync(path.join(serverRoot, 'prisma', 'migrations'))) {
    console.error(
      `[server] No Prisma migrations were found under ${serverRoot}. The server package is incomplete; reinstall or rebuild it.`,
    );
    process.exit(1);
  }
  const result = await migrateWithBackup(file, serverRoot, process.env.npm_package_version);

  if (!result.ok) {
    console.error('[server] Schema migration failed:', result.error);
    if (result.backupPath) {
      if (result.recovery?.status === 'restored') {
        console.error(`[server] Your database was restored from ${result.backupPath}.`);
      } else if (result.recovery?.status === 'failed') {
        console.error(
          `[server] Automatic database recovery failed: ${result.recovery.error}. Your pre-migration backup is available at ${result.backupPath}.`,
        );
      } else {
        console.error(
          `[server] The database was not restored because the migration did not modify it. A pre-migration backup is available at ${result.backupPath}.`,
        );
      }
    } else if (result.backupError) {
      console.error(`[server] A pre-migration backup could not be created: ${result.backupError}`);
      if (result.partialBackupPath) {
        console.error(
          `[server] An incomplete backup artifact may remain at ${result.partialBackupPath}.`,
        );
      }
    }
    if (result.failedPath) {
      console.error(`[server] The failed database was kept at ${result.failedPath}.`);
    }
    console.error(
      '[server] Not starting against a half-migrated database. Copy a diagnostic report from Settings → About and include it in a bug report.',
    );
    process.exit(1);
  }
}

async function main() {
  await runStartupMigrations();

  // Before anything queries: WAL and busy_timeout are per-connection settings, and the
  // download worker below starts writing almost immediately.
  await applySqlitePragmas();

  // Anything left IN_PROGRESS belongs to a previous run whose in-memory queue died with
  // it — see recoverInterruptedDownloads. Awaited so the queue is consistent before the
  // server starts accepting requests against it.
  await downloadWorker.recoverInterruptedDownloads();
  await recoverRestoreJobs();
  // Sweep only old, unreferenced private thumbnail files; never touch the legacy folder.
  void cacheService.pruneOrphanedThumbnails().catch((error) => {
    console.error('Failed to prune orphaned thumbnails', error);
  });

  trackerService.initializeTrackerPolling();
  startExtensionUpdateChecks();

  // Overload chosen rather than always passing a host: `listen(port)` binds every
  // interface, and passing an explicit '0.0.0.0' instead would quietly drop IPv6.
  const onListening = () => {
    const shown = env.SERVER_HOST ?? 'localhost';
    console.log(`Server running in ${env.NODE_ENV} mode on http://${shown}:${env.SERVER_PORT}`);
  };

  // Kept so shutdown() can stop accepting connections and let in-flight requests finish.
  httpServer = env.SERVER_HOST
    ? app.listen(env.SERVER_PORT, env.SERVER_HOST, onListening)
    : app.listen(env.SERVER_PORT, onListening);
}

let httpServer: import('node:http').Server | null = null;
let shuttingDown = false;

/**
 * How long in-flight requests get to finish before the process exits anyway.
 *
 * Bounded because the alternative is worse than a dropped response: the desktop
 * supervisor (apps/desktop/src/main/servers.ts) gives this child a grace period of its
 * own and then kills the tree, and a hosted deployment's init system does the same. A
 * shutdown that waits on a long-poll that never ends just means something else chooses
 * the exit for us, with no chance to dispose anything first.
 */
const SHUTDOWN_GRACE_MS = 10_000;

/**
 * Stops serving, then exits.
 *
 * Two things have to happen, in this order. `server.close()` stops accepting new
 * connections and resolves once the open ones are done, so a request that is mid-write —
 * a chapter page being streamed, a restore upload being parsed — completes instead of
 * having its socket torn off. Only then are the sandboxed source children disposed: they
 * are real child processes (see sandboxedSourceRegistry) and would otherwise outlive this
 * process as orphans, but killing them while a request is still waiting on one would turn
 * an orderly shutdown into a failed response.
 */
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] Received ${signal}, shutting down`);

  // unref so this timer is not itself a reason the process stays alive.
  const forceExit = setTimeout(() => {
    console.warn(
      `[server] Connections did not close within ${SHUTDOWN_GRACE_MS}ms, exiting anyway`,
    );
    disposeAllSandboxedSources();
    process.exit(0);
  }, SHUTDOWN_GRACE_MS);
  forceExit.unref();

  const finish = () => {
    clearTimeout(forceExit);
    disposeAllSandboxedSources();
    process.exit(0);
  };

  if (!httpServer) {
    finish();
    return;
  }
  httpServer.close((error) => {
    if (error) console.warn('[server] Error while closing the HTTP server:', error);
    finish();
  });
  // Idle keep-alive sockets hold `close()` open for their full timeout otherwise, which
  // for a browser that has finished loading the library is the common case.
  httpServer.closeIdleConnections();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch((error) => {
  console.error('Fatal startup error:', error);
  process.exit(1);
});
