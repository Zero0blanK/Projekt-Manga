/**
 * Loads a MariaDB snapshot (see export-mariadb-snapshot.mjs) into the SQLite database.
 *
 * The one-off other half of the MariaDB → SQLite move. The old migrations cannot replay
 * against SQLite, so the schema is recreated from the squashed `init_sqlite` migration and
 * the rows are carried across by this script instead.
 *
 * Two things it must get exactly right, because getting them subtly wrong looks like an
 * unrelated bug later:
 *
 * - `tracker_accounts.access_token` / `refresh_token` are ciphertext under
 *   TOKEN_ENCRYPTION_KEY. A single changed byte and every tracker connection fails to
 *   decrypt, with an error that says nothing about the import.
 * - `sessions.id` is a SHA-256 hash of the cookie value. Alter it and every existing login
 *   silently stops matching.
 *
 * Both are plain strings, so they are written through verbatim — no normalisation, no
 * trimming, no re-encoding. The `__buffer` case exists for the same reason.
 *
 * Usage:  node scripts/import-sqlite-snapshot.mjs <snapshot.json> [--dry-run]
 */
import fs from 'node:fs/promises';
import 'dotenv/config';
import { PrismaLibSql } from '@prisma/adapter-libsql';
import { PrismaClient } from '@prisma/client';

/** Physical table name -> Prisma model delegate name. */
const TABLE_TO_MODEL = {
  users: 'user',
  sessions: 'session',
  devices: 'device',
  mangas: 'manga',
  manga_details: 'manga_detail',
  chapters: 'chapter',
  caches: 'cache',
  histories: 'history',
  manga_library: 'manga_library',
  categories: 'category',
  manga_categories: 'manga_category',
  downloads: 'download',
  update_logs: 'update_log',
  extension_repositories: 'extension_repository',
  installed_extensions: 'installed_extension',
  tracker_accounts: 'tracker_account',
  tracker_links: 'tracker_link',
  user_library: 'user_library',
  user_manga_state: 'user_manga_state',
  user_chapter_state: 'user_chapter_state',
  user_manga_category: 'user_manga_category',
};

/** Columns Prisma types as Json. MariaDB handed these back already-parsed; SQLite wants
 * the value, and Prisma re-serialises it. A string that is really JSON has to be parsed
 * back or it would be stored as a JSON *string* rather than an array. */
const JSON_COLUMNS = { installed_extensions: ['allowed_hosts'] };

/** Inverse of the export's `serialise`. */
function deserialise(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && !Array.isArray(value)) {
    if ('__date' in value) return new Date(value.__date);
    if ('__bigint' in value) return BigInt(value.__bigint);
    if ('__buffer' in value) return Buffer.from(value.__buffer, 'base64');
  }
  return value;
}

/**
 * MariaDB stores booleans as TINYINT, so they arrive as 0/1. Prisma's SQLite client
 * rejects a number where the schema says Boolean, so those columns are coerced back.
 * Detected from the value rather than a column list: a hardcoded list would silently rot
 * the next time a Boolean column is added.
 */
function coerceRow(model, row, booleanFields) {
  const out = {};
  for (const [key, raw] of Object.entries(row)) {
    let value = deserialise(raw);
    if (booleanFields.has(key) && typeof value === 'number') value = value === 1;
    out[key] = value;
  }
  return out;
}

async function main() {
  const [snapshotPath, ...flags] = process.argv.slice(2);
  if (!snapshotPath) {
    console.error('usage: node scripts/import-sqlite-snapshot.mjs <snapshot.json> [--dry-run]');
    process.exit(1);
  }
  const dryRun = flags.includes('--dry-run');

  const snapshot = JSON.parse(await fs.readFile(snapshotPath, 'utf-8'));
  const url = process.env.DATABASE_URL ?? 'file:./data/projektmanga.db';
  if (!url.startsWith('file:')) {
    throw new Error(`DATABASE_URL must be a SQLite file URL, got "${url}"`);
  }

  const prisma = new PrismaClient({ adapter: new PrismaLibSql({ url }) });

  // Which fields are Boolean, per model, straight from the generated runtime metadata —
  // so this tracks the schema instead of a copy of it.
  const modelMeta = new Map();
  for (const model of prisma._runtimeDataModel?.models
    ? Object.entries(prisma._runtimeDataModel.models)
    : []) {
    const [name, def] = model;
    modelMeta.set(name, new Set(def.fields.filter((f) => f.type === 'Boolean').map((f) => f.name)));
  }

  const summary = [];
  try {
    for (const [table, model] of Object.entries(TABLE_TO_MODEL)) {
      const rows = snapshot.tables?.[table] ?? [];
      if (rows.length === 0) {
        summary.push(`${table}: 0`);
        continue;
      }

      const booleanFields = modelMeta.get(model) ?? new Set();
      const jsonColumns = JSON_COLUMNS[table] ?? [];

      const prepared = rows.map((row) => {
        const coerced = coerceRow(model, row, booleanFields);
        for (const column of jsonColumns) {
          if (typeof coerced[column] === 'string') {
            try {
              coerced[column] = JSON.parse(coerced[column]);
            } catch {
              /* leave as-is; Prisma will reject it loudly rather than storing nonsense */
            }
          }
        }
        return coerced;
      });

      if (dryRun) {
        summary.push(`${table}: ${prepared.length} (dry run)`);
        continue;
      }

      // One row at a time rather than createMany: a 2500-row batch that fails tells you
      // nothing about which row was bad, and this runs once per user in their lifetime.
      let inserted = 0;
      for (const data of prepared) {
        try {
          await prisma[model].create({ data });
          inserted += 1;
        } catch (error) {
          console.error(`[import] ${table} row failed:`, error.message.split('\n')[0]);
          console.error('[import] offending row id:', data.id ?? '(no id)');
          throw error;
        }
      }
      summary.push(`${table}: ${inserted}`);
      console.log(`[import] ${table}: ${inserted} rows`);
    }
  } finally {
    await prisma.$disconnect();
  }

  console.log(`\n[import] ${dryRun ? 'dry run' : 'complete'}`);
  console.log(summary.join('\n'));
}

main().catch((error) => {
  console.error('[import] failed:', error);
  process.exit(1);
});
