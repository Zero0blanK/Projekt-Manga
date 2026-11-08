/**
 * Builds throwaway SQLite databases at the schema of each released version, for
 * check-packaged.mjs's --migrations check.
 *
 *   node scripts/make-migration-fixtures.mjs <out-dir> [v1.0.0 v1.0.1 ...]
 *
 * For each tag it takes that release's migrations from git (not the working tree) and
 * applies them with the Prisma CLI the repository has installed, so `_prisma_migrations`
 * holds exactly the rows a user's database from that release holds. It then adds a small
 * library: titles, details, chapters with reading progress, a category, history and a
 * bookmark, using only columns that exist in the first schema.
 *
 * Only files inside <out-dir> are written, and it must be empty or not exist yet.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const [outArg, ...tagArgs] = process.argv.slice(2);
if (!outArg) throw new Error('Usage: node scripts/make-migration-fixtures.mjs <out-dir> [tags...]');
const OUT = path.resolve(outArg);
const TAGS = tagArgs.length > 0 ? tagArgs : ['v1.0.0', 'v1.0.1', 'v1.0.2', 'v1.1.0'];

if (fs.existsSync(OUT) && fs.readdirSync(OUT).length > 0) {
  throw new Error(`[fixtures] ${OUT} is not empty; pass a new folder`);
}
fs.mkdirSync(OUT, { recursive: true });

const PRISMA_CLI = path.join(ROOT, 'node_modules', 'prisma', 'build', 'index.js');

/**
 * Inserts a row, filling any other NOT NULL column without a default from its name and
 * type. Each release added required columns, and this keeps one seed working on all of them.
 */
function insert(db, table, row) {
  const columns = db.prepare(`PRAGMA table_info("${table}")`).all();
  const filled = { ...row };
  for (const column of columns) {
    if (column.name in filled || !column.notnull || column.dflt_value !== null || column.pk) {
      continue;
    }
    const type = String(column.type).toUpperCase();
    if (column.name === 'source' || column.name.endsWith('source_id'))
      filled[column.name] = 'fixture-source';
    else if (column.name.endsWith('_key')) filled[column.name] = String(row.id ?? column.name);
    else if (type.includes('DATE'))
      filled[column.name] = new Date('2026-09-01T00:00:00Z').toISOString();
    else if (type.includes('INT') || type.includes('REAL') || type.includes('BOOL'))
      filled[column.name] = 0;
    else filled[column.name] = '';
  }
  const names = Object.keys(filled);
  db.prepare(
    `INSERT INTO "${table}" (${names.map((n) => `"${n}"`).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
  ).run(...names.map((n) => filled[n]));
}

function seed(databaseFile) {
  const db = new DatabaseSync(databaseFile);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    for (let i = 1; i <= 3; i++) {
      const manga = `fixture-manga-${i}`;
      insert(db, 'mangas', {
        id: manga,
        slug: `fixture-${i}`,
        title: `Fixture title ${i}`,
        author: 'Fixture author',
        source: 'fixture-source',
        thumbnail_url: '',
        in_library: 1,
      });
      insert(db, 'manga_details', {
        id: `fixture-detail-${i}`,
        manga_id: manga,
        artist: 'Fixture artist',
        description: 'A title kept to test migrations.',
        genres: 'Action,Drama',
      });
      for (let c = 1; c <= 4; c++) {
        insert(db, 'chapters', {
          id: `fixture-chapter-${i}-${c}`,
          manga_id: manga,
          url: `https://fixture.invalid/${i}/${c}`,
          name: `Chapter ${c}`,
          is_read: c <= 2 ? 1 : 0,
          chapter_number: c,
          last_page_read: c === 3 ? 7 : 0,
          page_count: 20,
        });
      }
      insert(db, 'manga_library', { manga_id: manga, is_bookmarked: i === 1 ? 1 : 0 });
      insert(db, 'histories', {
        id: `fixture-history-${i}`,
        source: 'fixture-source',
        manga_id: manga,
        manga_slug: `fixture-${i}`,
        title: `Fixture title ${i}`,
        chapter_id: `fixture-chapter-${i}-3`,
        pages_read: 7,
      });
    }
    insert(db, 'categories', { id: 'fixture-category', name: 'Reading' });
    insert(db, 'manga_categories', {
      manga_id: 'fixture-manga-1',
      category_id: 'fixture-category',
    });
  } finally {
    db.close();
  }
}

for (const tag of TAGS) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `pm-fixture-${tag}-`));
  try {
    const server = path.join(work, 'server');
    fs.mkdirSync(server);
    // That release's prisma folder, straight from git.
    const files = execFileSync(
      'git',
      ['ls-tree', '-r', '--name-only', tag, '--', 'apps/server/prisma'],
      { cwd: ROOT, encoding: 'utf-8' },
    )
      .split('\n')
      .filter(Boolean);
    for (const file of files) {
      const target = path.join(server, path.relative('apps/server', file));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, execFileSync('git', ['show', `${tag}:${file}`], { cwd: ROOT }));
    }
    // The config imports prisma/config, which resolves through this link to the repo's own.
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(work, 'node_modules'), 'junction');
    fs.writeFileSync(
      path.join(server, 'prisma.config.mjs'),
      [
        "import { defineConfig, env } from 'prisma/config';",
        "export default defineConfig({ schema: './prisma/schema.prisma', datasource: { url: env('DATABASE_URL') } });",
        '',
      ].join('\n'),
    );
    const databaseFile = path.join(OUT, `${tag}.db`);
    execFileSync(process.execPath, [PRISMA_CLI, 'migrate', 'deploy'], {
      cwd: server,
      stdio: ['ignore', 'pipe', 'inherit'],
      env: { ...process.env, DATABASE_URL: `file:${databaseFile}` },
    });
    seed(databaseFile);
    const db = new DatabaseSync(databaseFile, { readOnly: true });
    const count = db.prepare('SELECT COUNT(*) AS n FROM _prisma_migrations').get().n;
    db.close();
    console.log(`[fixtures] ${tag}: ${count} migrations, seeded -> ${databaseFile}`);
  } finally {
    // The junction first, so removing the folder can never follow it into node_modules.
    const link = path.join(work, 'node_modules');
    if (fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) fs.rmdirSync(link);
    // Windows can hold a handle from the Prisma CLI for a moment after it exits (seen as
    // EPERM on the CI runner). The folder is only temporary, so cleanup must never fail
    // the run that produced the fixtures.
    try {
      fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch (error) {
      console.warn(`[fixtures] could not remove ${work}: ${error.message}`);
    }
  }
}
