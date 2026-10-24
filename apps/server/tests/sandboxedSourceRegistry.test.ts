import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { prismaMock } from './mocks/prismaMock.js';

const spawnSandboxedSource = vi.fn();
const dispose = vi.fn();

// The `/sandbox` subpath, matching what the registry imports.
vi.mock('@projekt-manga/extensions/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@projekt-manga/extensions/sandbox')>();
  return {
    ...actual,
    spawnSandboxedSource: (...args: unknown[]) => {
      spawnSandboxedSource(...args);
      return { id: 'test-source', dispose };
    },
  };
});

const { getInstalledSandboxedSources, disposeAllSandboxedSources } =
  await import('../src/services/sandboxedSourceRegistry.service.js');

const BUNDLE = 'export default { fetchManga: async () => [] };';
const BUNDLE_HASH = crypto.createHash('sha256').update(Buffer.from(BUNDLE)).digest('hex');

let tmpBundlesDir: string;

/** One enabled installed row, with its bundle written to disk. */
function installedRow(sourceCodeHash: string) {
  return {
    id: 'ext-1',
    repository_id: 'repo-1',
    source_key: 'test-source',
    name: 'Test Source',
    lang: 'en',
    base_url: 'https://example.com',
    is_nsfw: false,
    content_rating: 'safe',
    allowed_hosts: ['example.com'],
    version: '1.0.0',
    entry_url: 'https://example.com/bundle.js',
    source_code_hash: sourceCodeHash,
    enabled: true,
  };
}

async function writeBundle(contents: string) {
  const dir = path.join(tmpBundlesDir, 'ext-1');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'bundle.js'), contents);
}

beforeEach(async () => {
  tmpBundlesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'registry-test-'));
  process.env.EXTENSION_BUNDLES_DIR = tmpBundlesDir;
  spawnSandboxedSource.mockReset();
  dispose.mockReset();
});

afterEach(async () => {
  // The registry caches a live child per row for the process lifetime; without this a
  // source spawned by one test is reused by the next and its spawn never happens again.
  disposeAllSandboxedSources();
  delete process.env.EXTENSION_BUNDLES_DIR;
  await fs.rm(tmpBundlesDir, { recursive: true, force: true });
});

describe('getInstalledSandboxedSources', () => {
  it('runs a bundle whose bytes still match the hash recorded at install time', async () => {
    await writeBundle(BUNDLE);
    prismaMock.installed_extension.findMany.mockResolvedValueOnce([installedRow(BUNDLE_HASH)]);

    const sources = await getInstalledSandboxedSources();

    expect(sources).toHaveLength(1);
    expect(spawnSandboxedSource).toHaveBeenCalledTimes(1);
  });

  it('refuses to run a bundle that changed on disk after it was installed', async () => {
    // Same row, same recorded hash — but the file is no longer what was installed.
    await writeBundle('export default { fetchManga: async () => ["tampered"] };');
    prismaMock.installed_extension.findMany.mockResolvedValueOnce([installedRow(BUNDLE_HASH)]);

    const sources = await getInstalledSandboxedSources();

    expect(sources).toHaveLength(0);
    // The point: no child process is ever spawned against the modified file.
    expect(spawnSandboxedSource).not.toHaveBeenCalled();
  });

  it('skips an installed extension whose bundle file is missing', async () => {
    prismaMock.installed_extension.findMany.mockResolvedValueOnce([installedRow(BUNDLE_HASH)]);

    const sources = await getInstalledSandboxedSources();

    expect(sources).toHaveLength(0);
    expect(spawnSandboxedSource).not.toHaveBeenCalled();
  });
});
