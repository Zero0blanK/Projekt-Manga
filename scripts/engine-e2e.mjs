#!/usr/bin/env node
// The built-in extension engine, for real: downloads the Java runtime and Suwayomi-Server
// into a temporary folder, starts the engine, adds an extension repository, installs one
// extension, and reads popular titles, a title and one chapter's pages through it. Then
// removes everything.
//
// Opt-in, because it downloads about 235 MB and reaches real sites. Nothing third-party is
// written into this repository: the person running it says which repository and extension.
//
//   npm run build --workspace=@projekt-manga/server
//   ENGINE_E2E_REPOSITORY=https://…/index.min.json \
//   ENGINE_E2E_EXTENSION=<extension package name> \
//   node scripts/engine-e2e.mjs
//
// Without both variables it says so and exits 0, so a scheduled run without them set is a
// skip rather than a failure.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = process.env.ENGINE_E2E_REPOSITORY?.trim();
const extension = process.env.ENGINE_E2E_EXTENSION?.trim();
if (!repository || !extension) {
  console.log(
    '[engine-e2e] Skipped: set ENGINE_E2E_REPOSITORY and ENGINE_E2E_EXTENSION to run it.',
  );
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'apps/server/dist/services/suwayomi');
if (!fs.existsSync(path.join(dist, 'engine/index.js'))) {
  console.error(
    '[engine-e2e] Build the server first: npm run build --workspace=@projekt-manga/server',
  );
  process.exit(1);
}
const load = (file) => import(pathToFileURL(path.join(dist, file)).href);
const step = (label) => console.log(`[engine-e2e] ${label}`);

process.env.TOKEN_ENCRYPTION_KEY ??= crypto.randomBytes(32).toString('base64');
// Short, so Windows path limits never come into it.
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'pm-e2e-'));
const layout = await load('engine/layout.js');
const settings = await load('settings.js');
layout.setEngineRootForTests(path.join(work, 'engine'));
settings.setSuwayomiSettingsFileForTests(path.join(work, 'suwayomi.json'));
await load('engine/index.js');
const { installEngine, removeEngine } = await load('engine/install.js');
const { engineProcess } = await load('engine/process.js');
const repositories = await load('engine/repositories.js');
const extensions = await load('extensions.js');
const registry = await load('registry.js');

let failed = false;
try {
  step('Installing (Java runtime + engine)…');
  const started = Date.now();
  let lastStep = '';
  const record = await installEngine({
    onProgress: (progress) => {
      if (progress.step !== lastStep) step(`  ${(lastStep = progress.step)}`);
    },
  });
  step(
    `Installed ${record.active.server} on ${record.active.runtime} in ${Math.round((Date.now() - started) / 1000)}s`,
  );

  await settings.setSuwayomiMode('built-in');
  await engineProcess.start();
  if (engineProcess.status().state !== 'running') {
    throw new Error(`The engine did not start: ${engineProcess.status().error}`);
  }
  step('Engine running');

  const saved = await repositories.setEngineRepositories([repository]);
  step(`Repository: ${saved.map((item) => item.name).join(', ')}`);
  const listed = await extensions.listSuwayomiExtensions(true);
  step(`${listed.length} extensions listed`);
  if (!listed.some((item) => item.pkg_name === extension)) {
    throw new Error(`The repository has no extension ${extension}`);
  }
  await extensions.changeSuwayomiExtension(extension, 'install');
  step(`Installed ${extension}`);

  registry.forgetSuwayomiSourceList();
  const sources = await registry.getSuwayomiSources();
  if (sources.length === 0) throw new Error('The installed extension added no sources');
  const source = sources.find((item) => item.lang === 'en') ?? sources[0];
  step(`Source: ${source.name} (${source.lang})`);

  const popular = await source.fetchMangaPage('popular', { page: 1 }, {});
  const titles = popular.items;
  if (titles.length === 0) throw new Error('Popular returned no titles');
  step(`Popular: ${titles.length} titles`);

  const first = titles[0];
  const details = await source.fetchMangaDetails(first.slug);
  step(`Title: ${first.title}, ${details.chapters.length} chapters`);
  const chapter = details.chapters[0];
  if (!chapter) throw new Error('The title has no chapters');
  const pages = await source.fetchChapterPages(chapter.id, first.slug);
  const count = pages.items.length;
  if (count === 0) throw new Error('The chapter has no pages');
  step(`Chapter ${chapter.chapter_number}: ${count} pages`);
  step('Passed');
} catch (error) {
  failed = true;
  console.error(`[engine-e2e] Failed: ${error.message}`);
  const lines = engineProcess.status().lastLines;
  if (lines.length) console.error(lines.slice(-15).join('\n'));
} finally {
  await engineProcess.stop();
  await removeEngine({ keepData: false });
  await fsp.rm(work, { recursive: true, force: true }).catch(() => undefined);
  step('Removed everything');
}
process.exit(failed ? 1 : 0);
