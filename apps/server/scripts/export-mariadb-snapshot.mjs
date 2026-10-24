/**
 * Dumps every table of the MariaDB database to a single JSON file.
 *
 * Written before the SQLite migration and kept afterwards as the read half of the
 * one-off importer (see import-sqlite-snapshot.mjs). Reading through the `mariadb` driver
 * rather than Prisma is deliberate: once schema.prisma's provider becomes `sqlite`, the
 * generated client can no longer talk to MariaDB at all, so the export has to be
 * independent of it.
 *
 * Usage:  node scripts/export-mariadb-snapshot.mjs [outfile]
 * Reads DATABASE_URL from apps/server/.env.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import 'dotenv/config';
import mariadb from 'mariadb';

/**
 * Physical table names, parent-before-child.
 *
 * These are the `@@map` targets from schema.prisma (`mangas`, not `manga`) — the model
 * name and the table name differ for every model here, and querying by model name simply
 * finds nothing. Order matters on the way back in: a child row cannot be inserted before
 * the parent its foreign key points at.
 */
export const TABLE_ORDER = [
  'users',
  'sessions',
  'devices',
  'mangas',
  'manga_details',
  'chapters',
  'caches',
  'histories',
  'manga_library',
  'categories',
  'manga_categories',
  'downloads',
  'update_logs',
  'extension_repositories',
  'installed_extensions',
  'tracker_accounts',
  'tracker_links',
  'user_library',
  'user_manga_state',
  'user_chapter_state',
  'user_manga_category',
];

function parseDatabaseUrl(raw) {
  if (!raw) throw new Error('DATABASE_URL is not set — run this from apps/server.');
  const url = new URL(raw);
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username) || 'root',
    password: url.password ? decodeURIComponent(url.password) : undefined,
    database: decodeURIComponent(url.pathname.replace(/^\//, '')),
  };
}

/**
 * BigInt and Date are not JSON-serialisable, and Buffer round-trips as a useless object.
 * Dates become ISO strings and are parsed back on import; anything binary is base64'd with
 * a marker so the importer can restore the exact bytes — `session.id` hashes and
 * `tracker_account`'s encrypted tokens have to survive byte-for-byte or every login and
 * every tracker connection breaks.
 */
function serialise(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return { __bigint: value.toString() };
  if (value instanceof Date) return { __date: value.toISOString() };
  if (Buffer.isBuffer(value)) return { __buffer: value.toString('base64') };
  return value;
}

async function main() {
  const outFile = process.argv[2] ?? path.join(process.cwd(), 'mariadb-snapshot.json');
  const config = parseDatabaseUrl(process.env.DATABASE_URL);

  const conn = await mariadb.createConnection({ ...config, bigNumberStrings: false });
  const snapshot = { exportedAt: new Date().toISOString(), database: config.database, tables: {} };

  try {
    for (const table of TABLE_ORDER) {
      let rows;
      try {
        // Backticked because several table names (`user`, `session`, `cache`) are reserved
        // words in MySQL/MariaDB.
        rows = await conn.query(`SELECT * FROM \`${table}\``);
      } catch (error) {
        if (error?.code === 'ER_NO_SUCH_TABLE' || /doesn't exist/i.test(error?.message ?? '')) {
          console.warn(`[export] skipping ${table} (does not exist)`);
          snapshot.tables[table] = [];
          continue;
        }
        throw error;
      }

      snapshot.tables[table] = rows.map((row) =>
        Object.fromEntries(Object.entries(row).map(([k, v]) => [k, serialise(v)])),
      );
      console.log(`[export] ${table}: ${snapshot.tables[table].length} rows`);
    }
  } finally {
    await conn.end();
  }

  await fs.writeFile(outFile, JSON.stringify(snapshot, null, 2), 'utf-8');
  const total = Object.values(snapshot.tables).reduce((n, rows) => n + rows.length, 0);
  console.log(`[export] wrote ${total} rows across ${TABLE_ORDER.length} tables to ${outFile}`);
}

main().catch((error) => {
  console.error('[export] failed:', error);
  process.exit(1);
});
