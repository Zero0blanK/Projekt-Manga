import { PrismaLibSql } from '@prisma/adapter-libsql';
import { PrismaClient } from '@prisma/client';
import { loadEnv, resolveDatabaseConfig } from './env.js';

/**
 * The database connection.
 *
 * SQLite through libSQL. Two things worth knowing about that choice:
 *
 * - Prisma 7 has no built-in connector at runtime — `new PrismaClient()` with no adapter
 *   throws "A driver adapter is required". So an adapter package is not optional.
 * - libSQL rather than `@prisma/adapter-better-sqlite3` because better-sqlite3's native
 *   addon cannot be compiled on this project's Windows toolchain (the same reason
 *   apps/desktop uses `node:sqlite`). libSQL ships prebuilt N-API binaries, so it needs no
 *   compiler here and no ABI rebuild when it runs under Electron in the installer.
 *
 * process.env is already populated by configs/dotenv.config.ts, imported first in
 * server.ts. The connection is derived from DATABASE_URL — the same variable the Prisma
 * CLI uses for migrations — rather than a second, separate set of variables.
 */
const adapter = new PrismaLibSql({ url: resolveDatabaseConfig(loadEnv()).url });

const prisma = new PrismaClient({ adapter });

/**
 * Pragmas that have to be set per connection, applied once at startup.
 *
 * - **WAL.** The default `delete` journal takes a database-wide write lock, so the
 *   download worker, the sync endpoints, the tracker poll and migration.service.ts —
 *   all of which write concurrently — would serialise on each other and surface as
 *   SQLITE_BUSY. WAL lets readers proceed while a writer holds the lock, which is what
 *   makes this workload viable on a single file at all.
 * - **busy_timeout.** Writers still serialise against each other. Without a timeout the
 *   loser of a race fails instantly; with one it waits. Five seconds comfortably covers
 *   this app's longest single write (a title migration's transaction).
 *
 * Not fatal if they fail: the app still works with the defaults, just less well under
 * concurrency, and refusing to start over a pragma would be a worse trade.
 */
export async function applySqlitePragmas(): Promise<void> {
  try {
    await prisma.$queryRawUnsafe('PRAGMA journal_mode = WAL');
    await prisma.$executeRawUnsafe(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  } catch (error) {
    console.warn('[db] Could not apply SQLite pragmas:', error);
  }
}

export const BUSY_TIMEOUT_MS = 5000;

export default prisma;
