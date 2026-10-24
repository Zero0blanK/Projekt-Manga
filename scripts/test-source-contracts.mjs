import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.resolve(
  process.env.PROJEKT_MANGA_SOURCES_DIR ?? path.join(repoRoot, '..', 'projektmanga-sources'),
);
const schemasEntry = path.join(repoRoot, 'packages', 'schemas', 'dist', 'index.js');
const adapterTests = path.join(sourceRoot, 'tests', 'source-adapters.test.mjs');
const portTests = ['english-source-ports', 'japanese-source-ports', 'flamecomics'].map((name) =>
  path.join(sourceRoot, 'tests', `${name}.test.mjs`),
);

for (const filePath of [schemasEntry, adapterTests, ...portTests]) {
  if (!existsSync(filePath)) {
    throw new Error(`Required source contract test file is missing: ${filePath}`);
  }
}

const result = spawnSync(process.execPath, ['--test', adapterTests, ...portTests], {
  cwd: sourceRoot,
  env: {
    ...process.env,
    PROJEKT_MANGA_SCHEMAS_ENTRY: schemasEntry,
    REQUIRE_SHARED_SOURCE_SCHEMAS: '1',
  },
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
