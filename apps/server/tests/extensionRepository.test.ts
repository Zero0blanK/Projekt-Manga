import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { extensionListingEntrySchema } from '@projekt-manga/schemas';
import { extensionListingSigningPayload } from '../src/utils/extensionSignature.js';
import app from '../src/app.js';
import { prismaMock } from './mocks/prismaMock.js';

vi.mock('axios', () => ({ default: { get: vi.fn() } }));
import axios from 'axios';

/**
 * Controls the smoke test an update has to pass before it is promoted.
 *
 * Only `spawnSandboxedSource` is replaced — the rest of the module is real, because
 * app.ts loads bundled sources and the health controller reads the orchestrator through
 * it. `getFilters` is what extensionRepository.service.ts probes with.
 */
const smokeTestGetFilters = vi.fn();
const dispose = vi.fn();

// The `/sandbox` subpath, matching what the service imports — mocking the package root
// would silently miss, and the real sandbox would spawn child processes in the suite.
vi.mock('@projekt-manga/extensions/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@projekt-manga/extensions/sandbox')>();
  return {
    ...actual,
    spawnSandboxedSource: () => ({ getFilters: smokeTestGetFilters, dispose }),
  };
});

const VALID_INDEX = {
  sources: [
    {
      source_key: 'test-source',
      name: 'Test Source',
      lang: 'en',
      version: '1.0.0',
      entry_url: 'https://example.com/bundle.js',
      base_url: 'https://example.com',
      allowed_hosts: ['example.com'],
      isNSFW: false,
    },
  ],
};

let tmpBundlesDir: string;
let previousTrustKeys: string | undefined;

beforeEach(async () => {
  previousTrustKeys = process.env.EXTENSION_REPOSITORY_TRUST_KEYS;
  delete process.env.EXTENSION_REPOSITORY_TRUST_KEYS;
  tmpBundlesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-bundles-test-'));
  process.env.EXTENSION_BUNDLES_DIR = tmpBundlesDir;
  smokeTestGetFilters.mockReset().mockResolvedValue([]);
  dispose.mockReset();
});

afterEach(async () => {
  vi.mocked(axios.get).mockReset();
  delete process.env.EXTENSION_BUNDLES_DIR;
  if (previousTrustKeys === undefined) delete process.env.EXTENSION_REPOSITORY_TRUST_KEYS;
  else process.env.EXTENSION_REPOSITORY_TRUST_KEYS = previousTrustKeys;
  await fs.rm(tmpBundlesDir, { recursive: true, force: true });
});

// `id` is parameterised because extensionRepository.service.ts remembers a version that
// failed its smoke test, keyed by extension id, for the lifetime of the process. Sharing
// one id across tests would let that memory leak between them.
function mockExistingExtension(sourceCodeHash: string, id = 'ext-1') {
  prismaMock.installed_extension.findUnique.mockResolvedValueOnce({
    id,
    repository_id: 'repo-1',
    source_key: 'test-source',
    name: 'Test Source',
    lang: 'en',
    base_url: 'https://example.com',
    is_nsfw: false,
    allowed_hosts: ['example.com'],
    version: '1.0.0',
    entry_url: 'https://example.com/bundle.js',
    source_code_hash: sourceCodeHash,
  });
  prismaMock.extension_repository.findUnique.mockResolvedValueOnce({
    id: 'repo-1',
    url: 'https://example.com/repo.json',
  });
}

function mockIndexFetch(index: unknown = VALID_INDEX) {
  vi.mocked(axios.get).mockResolvedValueOnce({ data: Buffer.from(JSON.stringify(index)) });
}

function mockBundleFetch(content = 'export default { fetchManga: async () => [] };') {
  vi.mocked(axios.get).mockResolvedValueOnce({ data: Buffer.from(content) });
}

function sha256Of(content: string): string {
  return crypto.createHash('sha256').update(Buffer.from(content)).digest('hex');
}

function signIndexEntry(bundle: string) {
  const repositoryUrl = 'https://example.com/repo.json';
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const entry = extensionListingEntrySchema.parse(indexDeclaring(bundle).sources[0]);
  const signature = crypto
    .sign(null, extensionListingSigningPayload(repositoryUrl, entry), privateKey)
    .toString('base64url');
  return {
    entry: {
      ...entry,
      signature: { algorithm: 'ed25519' as const, key_id: 'repo-2026', value: signature },
    },
    publicKey,
    repositoryUrl,
  };
}

/** VALID_INDEX with extra fields merged into its single source entry. */
function indexWith(overrides: Record<string, unknown>) {
  return { ...VALID_INDEX, sources: [{ ...VALID_INDEX.sources[0], ...overrides }] };
}

/**
 * An index whose entry declares integrity for `content`, optionally corrupted.
 *
 * Defaults to the *correct* hash and size so a test only has to say which of the two it
 * wants wrong — writing both out by hand in each test is how a "mismatch" test ends up
 * passing because some unrelated field was wrong too.
 */
function indexDeclaring(content: string, corrupt: { sha256?: string; size?: number } = {}) {
  return indexWith({
    bundle: {
      sha256: corrupt.sha256 ?? sha256Of(content),
      size: corrupt.size ?? Buffer.byteLength(content),
    },
  });
}

describe('POST /api/extensions/repositories', () => {
  it('rejects a non-URL body with 400', async () => {
    const res = await request(app).post('/api/extensions/repositories').send({ url: 'not-a-url' });
    expect(res.status).toBe(400);
  });

  it('fetches and validates the index before storing the repository', async () => {
    prismaMock.extension_repository.findUnique.mockResolvedValueOnce(null);
    mockIndexFetch();
    prismaMock.extension_repository.create.mockResolvedValueOnce({
      id: 'repo-1',
      url: 'https://example.com/repo.json',
      name: null,
      added_at: new Date(),
      last_fetched_at: new Date(),
      enabled: true,
    });

    const res = await request(app)
      .post('/api/extensions/repositories')
      .send({ url: 'https://example.com/repo.json' });

    expect(res.status).toBe(201);
    expect(res.body.data.id).toBe('repo-1');
  });

  it('409s when the repository URL was already added', async () => {
    prismaMock.extension_repository.findUnique.mockResolvedValueOnce({
      id: 'repo-1',
      url: 'https://example.com/repo.json',
    });

    const res = await request(app)
      .post('/api/extensions/repositories')
      .send({ url: 'https://example.com/repo.json' });

    expect(res.status).toBe(409);
    expect(axios.get).not.toHaveBeenCalled();
  });

  it("rejects an index that doesn't match the expected schema", async () => {
    prismaMock.extension_repository.findUnique.mockResolvedValueOnce(null);
    mockIndexFetch({ sources: [{ source_key: 'x' }] }); // missing required fields

    const res = await request(app)
      .post('/api/extensions/repositories')
      .send({ url: 'https://example.com/repo.json' });

    expect(res.status).toBe(400);
    expect(prismaMock.extension_repository.create).not.toHaveBeenCalled();
  });

  it('refuses an index whose format_version is newer than this app understands', async () => {
    prismaMock.extension_repository.findUnique.mockResolvedValueOnce(null);
    mockIndexFetch({ ...VALID_INDEX, format_version: 99 });

    const res = await request(app)
      .post('/api/extensions/repositories')
      .send({ url: 'https://example.com/repo.json' });

    expect(res.status).toBe(400);
    expect(prismaMock.extension_repository.create).not.toHaveBeenCalled();
  });

  it("stores the repository's own name so the UI need not show a raw URL", async () => {
    prismaMock.extension_repository.findUnique.mockResolvedValueOnce(null);
    mockIndexFetch({ ...VALID_INDEX, repository: { name: 'ProjektManga sources' } });
    prismaMock.extension_repository.create.mockResolvedValueOnce({
      id: 'repo-1',
      url: 'https://example.com/repo.json',
      name: 'ProjektManga sources',
      added_at: new Date(),
      last_fetched_at: new Date(),
      enabled: true,
    });

    const res = await request(app)
      .post('/api/extensions/repositories')
      .send({ url: 'https://example.com/repo.json' });

    expect(res.status).toBe(201);
    expect(prismaMock.extension_repository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ name: 'ProjektManga sources' }),
      }),
    );
  });

  it('stores a null name when the index publishes none', async () => {
    prismaMock.extension_repository.findUnique.mockResolvedValueOnce(null);
    mockIndexFetch(); // VALID_INDEX has no repository block
    prismaMock.extension_repository.create.mockResolvedValueOnce({
      id: 'repo-1',
      url: 'https://example.com/repo.json',
      name: null,
      added_at: new Date(),
      last_fetched_at: new Date(),
      enabled: true,
    });

    await request(app)
      .post('/api/extensions/repositories')
      .send({ url: 'https://example.com/repo.json' });

    expect(prismaMock.extension_repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ name: null }) }),
    );
  });

  it('accepts an index at the format version it does understand', async () => {
    prismaMock.extension_repository.findUnique.mockResolvedValueOnce(null);
    mockIndexFetch({ ...VALID_INDEX, format_version: 1 });
    prismaMock.extension_repository.create.mockResolvedValueOnce({
      id: 'repo-1',
      url: 'https://example.com/repo.json',
      name: null,
      added_at: new Date(),
      last_fetched_at: null,
      enabled: true,
    });

    const res = await request(app)
      .post('/api/extensions/repositories')
      .send({ url: 'https://example.com/repo.json' });

    expect(res.status).toBe(201);
  });
});

describe('POST /api/extensions/installed', () => {
  it('downloads, hashes, and stores a new installed extension', async () => {
    prismaMock.extension_repository.findUnique.mockResolvedValueOnce({
      id: 'repo-1',
      url: 'https://example.com/repo.json',
    });
    prismaMock.installed_extension.findUnique.mockResolvedValueOnce(null);
    mockIndexFetch();
    mockBundleFetch();
    prismaMock.installed_extension.create.mockResolvedValueOnce({
      id: 'ext-1',
      repository_id: 'repo-1',
      source_key: 'test-source',
      name: 'Test Source',
      lang: 'en',
      base_url: 'https://example.com',
      is_nsfw: false,
      allowed_hosts: ['example.com'],
      version: '1.0.0',
      entry_url: 'https://example.com/bundle.js',
      source_code_hash: 'irrelevant-for-this-assertion',
      installed_at: new Date(),
      updated_at: new Date(),
      enabled: true,
    });

    const res = await request(app)
      .post('/api/extensions/installed')
      .send({ repository_id: 'repo-1', source_key: 'test-source', acknowledge_unsigned: true });

    expect(res.status).toBe(201);
    expect(res.body.data.source_key).toBe('test-source');

    const bundlePath = path.join(tmpBundlesDir, 'ext-1', 'bundle.js');
    const written = await fs.readFile(bundlePath, 'utf-8');
    expect(written).toContain('fetchManga');
  });

  it('refuses a bundle whose checksum does not match the listing', async () => {
    prismaMock.extension_repository.findUnique.mockResolvedValueOnce({
      id: 'repo-1',
      url: 'https://example.com/repo.json',
    });
    prismaMock.installed_extension.findUnique.mockResolvedValueOnce(null);

    const bundle = 'export default { fetchManga: async () => [] };';
    mockIndexFetch(indexDeclaring(bundle, { sha256: 'f'.repeat(64) }));
    mockBundleFetch(bundle);

    const res = await request(app)
      .post('/api/extensions/installed')
      .send({ repository_id: 'repo-1', source_key: 'test-source', acknowledge_unsigned: true });

    expect(res.status).toBe(400);
    // The whole point: nothing is recorded, so the wrong bytes cannot become the baseline
    // that future update checks compare against.
    expect(prismaMock.installed_extension.create).not.toHaveBeenCalled();
  });

  it('refuses a bundle whose size does not match the listing', async () => {
    prismaMock.extension_repository.findUnique.mockResolvedValueOnce({
      id: 'repo-1',
      url: 'https://example.com/repo.json',
    });
    prismaMock.installed_extension.findUnique.mockResolvedValueOnce(null);

    const bundle = 'export default { fetchManga: async () => [] };';
    mockIndexFetch(indexDeclaring(bundle, { size: 999_999 }));
    mockBundleFetch(bundle);

    const res = await request(app)
      .post('/api/extensions/installed')
      .send({ repository_id: 'repo-1', source_key: 'test-source', acknowledge_unsigned: true });

    expect(res.status).toBe(400);
    expect(prismaMock.installed_extension.create).not.toHaveBeenCalled();
  });

  it('requires a valid signature for a repository with an operator-trusted key', async () => {
    const bundle = 'export default { fetchManga: async () => [] };';
    const { entry, publicKey, repositoryUrl } = signIndexEntry(bundle);
    process.env.EXTENSION_REPOSITORY_TRUST_KEYS = JSON.stringify({
      [repositoryUrl]: [
        {
          key_id: 'repo-2026',
          public_key: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
        },
      ],
    });
    prismaMock.extension_repository.findUnique.mockResolvedValueOnce({
      id: 'repo-1',
      url: repositoryUrl,
    });
    prismaMock.installed_extension.findUnique.mockResolvedValueOnce(null);
    mockIndexFetch({ sources: [entry] });
    mockBundleFetch(bundle);
    prismaMock.installed_extension.create.mockResolvedValueOnce({ id: 'signed-ext' });

    const valid = await request(app)
      .post('/api/extensions/installed')
      .send({ repository_id: 'repo-1', source_key: 'test-source', acknowledge_unsigned: true });
    expect(valid.status).toBe(201);

    prismaMock.extension_repository.findUnique.mockResolvedValueOnce({
      id: 'repo-1',
      url: repositoryUrl,
    });
    prismaMock.installed_extension.findUnique.mockResolvedValueOnce(null);
    const { signature: _signature, ...unsignedEntry } = entry;
    mockIndexFetch({ sources: [unsignedEntry] });
    mockBundleFetch(bundle);

    const unsigned = await request(app)
      .post('/api/extensions/installed')
      .send({ repository_id: 'repo-1', source_key: 'test-source', acknowledge_unsigned: true });
    expect(unsigned.status).toBe(400);
    expect(unsigned.body.message).toContain('did not sign');
    expect(prismaMock.installed_extension.create).toHaveBeenCalledTimes(1);
  });

  it('installs when the bundle matches the checksum the listing declares', async () => {
    prismaMock.extension_repository.findUnique.mockResolvedValueOnce({
      id: 'repo-1',
      url: 'https://example.com/repo.json',
    });
    prismaMock.installed_extension.findUnique.mockResolvedValueOnce(null);

    const bundle = 'export default { fetchManga: async () => [] };';
    mockIndexFetch(indexDeclaring(bundle));
    mockBundleFetch(bundle);
    prismaMock.installed_extension.create.mockResolvedValueOnce({
      id: 'ext-hash-ok',
      repository_id: 'repo-1',
      source_key: 'test-source',
      name: 'Test Source',
      lang: 'en',
      base_url: 'https://example.com',
      is_nsfw: false,
      allowed_hosts: ['example.com'],
      version: '1.0.0',
      entry_url: 'https://example.com/bundle.js',
      source_code_hash: sha256Of(bundle),
      installed_at: new Date(),
      updated_at: new Date(),
      enabled: true,
    });

    const res = await request(app)
      .post('/api/extensions/installed')
      .send({ repository_id: 'repo-1', source_key: 'test-source', acknowledge_unsigned: true });

    expect(res.status).toBe(201);
  });

  it('captures the listing metadata the repository publishes', async () => {
    prismaMock.extension_repository.findUnique.mockResolvedValueOnce({
      id: 'repo-1',
      url: 'https://example.com/repo.json',
    });
    prismaMock.installed_extension.findUnique.mockResolvedValueOnce(null);
    mockIndexFetch(
      indexWith({
        content_rating: 'mixed',
        version_code: 1_000_000,
        description: 'A general catalogue.',
        homepage: 'https://example.com',
        icon_url: 'https://example.com/icon.svg',
      }),
    );
    mockBundleFetch();
    prismaMock.installed_extension.create.mockResolvedValueOnce({ id: 'ext-meta' });

    await request(app)
      .post('/api/extensions/installed')
      .send({ repository_id: 'repo-1', source_key: 'test-source', acknowledge_unsigned: true });

    expect(prismaMock.installed_extension.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          api_version: 1,
          content_rating: 'mixed',
          version_code: 1_000_000,
          description: 'A general catalogue.',
          homepage: 'https://example.com',
          icon_url: 'https://example.com/icon.svg',
        }),
      }),
    );
  });

  it('stores nulls for listing metadata a repository omits', async () => {
    prismaMock.extension_repository.findUnique.mockResolvedValueOnce({
      id: 'repo-1',
      url: 'https://example.com/repo.json',
    });
    prismaMock.installed_extension.findUnique.mockResolvedValueOnce(null);
    mockIndexFetch(); // VALID_INDEX carries none of the optional fields
    mockBundleFetch();
    prismaMock.installed_extension.create.mockResolvedValueOnce({ id: 'ext-bare' });

    await request(app)
      .post('/api/extensions/installed')
      .send({ repository_id: 'repo-1', source_key: 'test-source', acknowledge_unsigned: true });

    expect(prismaMock.installed_extension.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          content_rating: null,
          version_code: null,
          icon_url: null,
        }),
      }),
    );
  });

  it('refuses a source built against a newer extension API than this app supports', async () => {
    prismaMock.extension_repository.findUnique.mockResolvedValueOnce({
      id: 'repo-1',
      url: 'https://example.com/repo.json',
    });
    prismaMock.installed_extension.findUnique.mockResolvedValueOnce(null);
    mockIndexFetch(indexWith({ api_version: 99 }));

    const res = await request(app)
      .post('/api/extensions/installed')
      .send({ repository_id: 'repo-1', source_key: 'test-source', acknowledge_unsigned: true });

    expect(res.status).toBe(400);
    // Refused before the bundle is even fetched — there is no point downloading code we
    // already know we cannot drive.
    expect(vi.mocked(axios.get).mock.calls.length).toBe(1);
    expect(prismaMock.installed_extension.create).not.toHaveBeenCalled();
  });

  it('404s when the source_key is not in the repository listing', async () => {
    prismaMock.extension_repository.findUnique.mockResolvedValueOnce({
      id: 'repo-1',
      url: 'https://example.com/repo.json',
    });
    prismaMock.installed_extension.findUnique.mockResolvedValueOnce(null);
    mockIndexFetch();

    const res = await request(app)
      .post('/api/extensions/installed')
      .send({ repository_id: 'repo-1', source_key: 'does-not-exist', acknowledge_unsigned: true });

    expect(res.status).toBe(404);
  });

  it('409s when this source is already installed from this repository', async () => {
    prismaMock.extension_repository.findUnique.mockResolvedValueOnce({
      id: 'repo-1',
      url: 'https://example.com/repo.json',
    });
    prismaMock.installed_extension.findUnique.mockResolvedValueOnce({
      id: 'ext-1',
      repository_id: 'repo-1',
      source_key: 'test-source',
    });

    const res = await request(app)
      .post('/api/extensions/installed')
      .send({ repository_id: 'repo-1', source_key: 'test-source', acknowledge_unsigned: true });

    expect(res.status).toBe(409);
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('409s when another repository already provides this source key', async () => {
    // Two repositories publishing "test-source" is legal storage — the unique constraint is
    // on (repository_id, source_key) — but only one of the two can ever be served, so the
    // second install would sit in the list doing nothing. Discover disables the button for
    // this, yet the two entries have separate per-repository busy keys, so a fast pair of
    // clicks (and any direct API call) still arrives here.
    prismaMock.extension_repository.findUnique.mockResolvedValueOnce({
      id: 'repo-2',
      url: 'https://example.com/other-repo.json',
    });
    prismaMock.installed_extension.findUnique.mockResolvedValueOnce(null);
    prismaMock.installed_extension.findMany.mockResolvedValueOnce([
      { id: 'ext-1', repository_id: 'repo-1', source_key: 'test-source', enabled: true },
    ]);

    const res = await request(app)
      .post('/api/extensions/installed')
      .send({ repository_id: 'repo-2', source_key: 'test-source', acknowledge_unsigned: true });

    expect(res.status).toBe(409);
    // Refused before any bundle is fetched, not after paying for the download.
    expect(axios.get).not.toHaveBeenCalled();
  });
});

describe('POST /api/extensions/repositories/:id/refresh', () => {
  /**
   * Repository indexes sit behind a CDN — GitHub's raw host sends
   * `Cache-Control: max-age=300` — so for five minutes after a publisher pushes, requesting
   * the same URL keeps returning the *previous* index. Observed directly: the app reported
   * mangageko 1.0.0 while the origin was already serving 1.1.0.
   *
   * Passive listing can live with that. "Refresh" cannot: it means "check now", and without
   * a unique URL it hands back the same stale answer however many times it is pressed, with
   * nothing to indicate anything was cached.
   */
  it('requests a unique URL so a CDN cannot answer from cache', async () => {
    prismaMock.extension_repository.findUnique.mockResolvedValueOnce({
      id: 'repo-1',
      url: 'https://example.com/repo.json',
    });
    mockIndexFetch();
    prismaMock.extension_repository.update.mockResolvedValueOnce({
      id: 'repo-1',
      url: 'https://example.com/repo.json',
    });

    const res = await request(app).post('/api/extensions/repositories/repo-1/refresh');

    expect(res.status).toBe(200);
    const requested = vi.mocked(axios.get).mock.calls[0][0] as string;
    expect(requested).toContain('https://example.com/repo.json');
    // The buster has to actually vary, or it is just a longer constant URL.
    expect(requested).toMatch(/[?&]_=\d+/);
  });

  it('leaves the plain listing uncached-busted, so browsing does not hammer the origin', async () => {
    prismaMock.extension_repository.findMany.mockResolvedValueOnce([
      { id: 'repo-1', url: 'https://example.com/repo.json' },
    ]);
    mockIndexFetch();

    const res = await request(app).get('/api/extensions/repositories');

    expect(res.status).toBe(200);
    const requested = vi.mocked(axios.get).mock.calls[0][0] as string;
    expect(requested).toBe('https://example.com/repo.json');
  });
});

describe('POST /api/extensions/installed/:id/update', () => {
  it('reports changed:false when the bundle hash and metadata are unchanged', async () => {
    const existing = {
      id: 'ext-1',
      repository_id: 'repo-1',
      source_key: 'test-source',
      name: 'Test Source',
      lang: 'en',
      base_url: 'https://example.com',
      is_nsfw: false,
      allowed_hosts: ['example.com'],
      version: '1.0.0',
      entry_url: 'https://example.com/bundle.js',
      // sha256 of 'export default { fetchManga: async () => [] };'
      source_code_hash: crypto
        .createHash('sha256')
        .update('export default { fetchManga: async () => [] };')
        .digest('hex'),
    };
    prismaMock.installed_extension.findUnique.mockResolvedValueOnce(existing);
    prismaMock.extension_repository.findUnique.mockResolvedValueOnce({
      id: 'repo-1',
      url: 'https://example.com/repo.json',
    });
    mockIndexFetch();
    mockBundleFetch();

    const res = await request(app).post('/api/extensions/installed/ext-1/update');

    expect(res.status).toBe(200);
    expect(res.body.data.changed).toBe(false);
    expect(prismaMock.installed_extension.update).not.toHaveBeenCalled();
  });

  it('treats a changed content_rating as an update even when the bundle is identical', async () => {
    const bundle = 'export default { fetchManga: async () => [] };';
    await fs.mkdir(path.join(tmpBundlesDir, 'ext-rating'), { recursive: true });
    await fs.writeFile(path.join(tmpBundlesDir, 'ext-rating', 'bundle.js'), bundle);
    // Same bytes, same version — only the declared rating moved, from mixed to nsfw. That
    // changes whether the source is badged as adult, so it must not be silently ignored.
    prismaMock.installed_extension.findUnique.mockResolvedValueOnce({
      id: 'ext-rating',
      repository_id: 'repo-1',
      source_key: 'test-source',
      name: 'Test Source',
      lang: 'en',
      base_url: 'https://example.com',
      is_nsfw: false,
      content_rating: 'mixed',
      allowed_hosts: ['example.com'],
      version: '1.0.0',
      entry_url: 'https://example.com/bundle.js',
      source_code_hash: sha256Of(bundle),
    });
    prismaMock.extension_repository.findUnique.mockResolvedValueOnce({
      id: 'repo-1',
      url: 'https://example.com/repo.json',
    });
    mockIndexFetch(indexWith({ content_rating: 'nsfw' }));
    mockBundleFetch(bundle);
    prismaMock.installed_extension.update.mockResolvedValueOnce({ id: 'ext-rating' });

    const res = await request(app).post('/api/extensions/installed/ext-rating/update');

    expect(res.status).toBe(200);
    expect(res.body.data.changed).toBe(true);
    expect(prismaMock.installed_extension.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ content_rating: 'nsfw' }),
      }),
    );
  });

  it('does not downgrade when the listing serves an older version than the installed one', async () => {
    // Installed 2.0.0; the repository is briefly serving 1.0.0 — a rollback, or a cache
    // handing back an older index. The bundle differs, so every "has anything changed?"
    // check below would say yes and overwrite a newer working source with an older one.
    prismaMock.installed_extension.findUnique.mockResolvedValueOnce({
      id: 'ext-downgrade',
      repository_id: 'repo-1',
      source_key: 'test-source',
      name: 'Test Source',
      lang: 'en',
      base_url: 'https://example.com',
      is_nsfw: false,
      allowed_hosts: ['example.com'],
      version: '2.0.0',
      entry_url: 'https://example.com/bundle.js',
      source_code_hash: 'hash-of-the-installed-2.0.0-bundle',
    });
    prismaMock.extension_repository.findUnique.mockResolvedValueOnce({
      id: 'repo-1',
      url: 'https://example.com/repo.json',
    });
    mockIndexFetch(); // VALID_INDEX is version 1.0.0
    mockBundleFetch('export default { fetchManga: async () => ["older"] };');

    const res = await request(app).post('/api/extensions/installed/ext-downgrade/update');

    expect(res.status).toBe(200);
    expect(res.body.data.changed).toBe(false);
    expect(prismaMock.installed_extension.update).not.toHaveBeenCalled();
  });

  it('applies an upgrade whose listing publishes a small version_code alongside a semver string', async () => {
    await fs.mkdir(path.join(tmpBundlesDir, 'ext-version-code'), { recursive: true });
    await fs.writeFile(path.join(tmpBundlesDir, 'ext-version-code', 'bundle.js'), 'OLD BUNDLE');
    // The regression this guards: `version_code` is a publisher-chosen counter (the schema
    // allows any non-negative int, so real listings use 2, 3, 17...), while a version
    // *string* only orders after being parsed onto a major*1e6 + minor*1e3 + patch scale.
    // Comparing one against the other puts an upgrade like version_code 2 against a parsed
    // 1.0.0 (= 1_000_000) and reads it as a massive downgrade, so the update is refused —
    // permanently, since every later check makes the same comparison. The installed row
    // stores its own version_code for exactly this comparison; it has to be the side used
    // whenever the listing offers one.
    const existing = {
      id: 'ext-version-code',
      repository_id: 'repo-1',
      source_key: 'test-source',
      name: 'Test Source',
      lang: 'en',
      base_url: 'https://example.com',
      is_nsfw: false,
      allowed_hosts: ['example.com'],
      version: '1.0.0',
      version_code: 1,
      entry_url: 'https://example.com/bundle.js',
      source_code_hash: 'stale-hash-that-will-not-match',
    };
    prismaMock.installed_extension.findUnique.mockResolvedValueOnce(existing);
    prismaMock.extension_repository.findUnique.mockResolvedValueOnce({
      id: 'repo-1',
      url: 'https://example.com/repo.json',
    });
    mockIndexFetch(indexWith({ version: '2.0.0', version_code: 2 }));
    mockBundleFetch('export default { fetchManga: async () => [2] };');
    prismaMock.installed_extension.update.mockResolvedValueOnce({ ...existing, version: '2.0.0' });

    const res = await request(app).post('/api/extensions/installed/ext-version-code/update');

    expect(res.status).toBe(200);
    expect(res.body.data.changed).toBe(true);
    expect(prismaMock.installed_extension.update).toHaveBeenCalled();
  });

  it('still refuses a downgrade when both sides publish a version_code', async () => {
    // The mirror of the case above: comparing like with like has to keep rejecting a
    // genuine rollback, not just start accepting everything.
    const existing = {
      id: 'ext-version-code-down',
      repository_id: 'repo-1',
      source_key: 'test-source',
      name: 'Test Source',
      lang: 'en',
      base_url: 'https://example.com',
      is_nsfw: false,
      allowed_hosts: ['example.com'],
      version: '2.0.0',
      version_code: 9,
      entry_url: 'https://example.com/bundle.js',
      source_code_hash: 'stale-hash-that-will-not-match',
    };
    prismaMock.installed_extension.findUnique.mockResolvedValueOnce(existing);
    prismaMock.extension_repository.findUnique.mockResolvedValueOnce({
      id: 'repo-1',
      url: 'https://example.com/repo.json',
    });
    mockIndexFetch(indexWith({ version: '1.0.0', version_code: 4 }));
    mockBundleFetch('export default { fetchManga: async () => ["older"] };');

    const res = await request(app).post('/api/extensions/installed/ext-version-code-down/update');

    expect(res.status).toBe(200);
    expect(res.body.data.changed).toBe(false);
    expect(prismaMock.installed_extension.update).not.toHaveBeenCalled();
  });

  it('reports changed:true and persists the new hash when the bundle content differs', async () => {
    await fs.mkdir(path.join(tmpBundlesDir, 'ext-1'), { recursive: true });
    await fs.writeFile(path.join(tmpBundlesDir, 'ext-1', 'bundle.js'), 'OLD BUNDLE');
    const existing = {
      id: 'ext-1',
      repository_id: 'repo-1',
      source_key: 'test-source',
      name: 'Test Source',
      lang: 'en',
      base_url: 'https://example.com',
      is_nsfw: false,
      allowed_hosts: ['example.com'],
      version: '1.0.0',
      entry_url: 'https://example.com/bundle.js',
      source_code_hash: 'stale-hash-that-will-not-match',
    };
    prismaMock.installed_extension.findUnique.mockResolvedValueOnce(existing);
    prismaMock.extension_repository.findUnique.mockResolvedValueOnce({
      id: 'repo-1',
      url: 'https://example.com/repo.json',
    });
    mockIndexFetch();
    mockBundleFetch();
    prismaMock.installed_extension.update.mockResolvedValueOnce({
      ...existing,
      source_code_hash: 'new-hash',
    });

    const res = await request(app).post('/api/extensions/installed/ext-1/update');

    expect(res.status).toBe(200);
    expect(res.body.data.changed).toBe(true);
    expect(prismaMock.installed_extension.update).toHaveBeenCalled();
  });

  it('promotes the staged bundle over the live one and leaves no staging file behind', async () => {
    const dir = path.join(tmpBundlesDir, 'ext-promote');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'bundle.js'), 'OLD BUNDLE');

    mockExistingExtension('stale-hash-that-will-not-match', 'ext-promote');
    mockIndexFetch();
    mockBundleFetch('export default { fetchManga: async () => [1] };');
    prismaMock.installed_extension.update.mockResolvedValueOnce({ id: 'ext-promote' });

    const res = await request(app).post('/api/extensions/installed/ext-promote/update');

    expect(res.status).toBe(200);
    expect(await fs.readFile(path.join(dir, 'bundle.js'), 'utf-8')).toContain('[1]');
    await expect(fs.access(path.join(dir, 'bundle.next.js'))).rejects.toThrow();
  });

  it('restores the previous bundle if metadata persistence fails after promotion', async () => {
    const dir = path.join(tmpBundlesDir, 'ext-rollback');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'bundle.js'), 'OLD BUNDLE');

    mockExistingExtension('stale-hash-that-will-not-match', 'ext-rollback');
    mockIndexFetch();
    mockBundleFetch('export default { fetchManga: async () => [1] };');
    prismaMock.installed_extension.update.mockRejectedValueOnce(new Error('database unavailable'));

    const res = await request(app).post('/api/extensions/installed/ext-rollback/update');

    expect(res.status).toBe(500);
    expect(await fs.readFile(path.join(dir, 'bundle.js'), 'utf8')).toBe('OLD BUNDLE');
    await expect(fs.access(path.join(dir, 'bundle.previous.js'))).rejects.toThrow();
    await expect(fs.access(path.join(dir, 'bundle.next.js'))).rejects.toThrow();
  });

  it('recovers a previous bundle left by an interrupted update before checking the repository', async () => {
    const dir = path.join(tmpBundlesDir, 'ext-recover');
    const previous = 'export default { fetchManga: async () => [] };';
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'bundle.js'), 'PARTIALLY PROMOTED BUNDLE');
    await fs.writeFile(path.join(dir, 'bundle.previous.js'), previous);

    mockExistingExtension(sha256Of(previous), 'ext-recover');
    mockIndexFetch();
    mockBundleFetch(previous);

    const res = await request(app).post('/api/extensions/installed/ext-recover/update');

    expect(res.status).toBe(200);
    expect(res.body.data.changed).toBe(false);
    expect(await fs.readFile(path.join(dir, 'bundle.js'), 'utf8')).toBe(previous);
    await expect(fs.access(path.join(dir, 'bundle.previous.js'))).rejects.toThrow();
  });

  it('keeps the working bundle when the new one fails its smoke test', async () => {
    const dir = path.join(tmpBundlesDir, 'ext-fail');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'bundle.js'), 'OLD BUNDLE');

    mockExistingExtension('stale-hash-that-will-not-match', 'ext-fail');
    mockIndexFetch();
    mockBundleFetch('this bundle is broken');
    smokeTestGetFilters.mockRejectedValueOnce(
      new Error('Bundle does not default-export a valid Source implementation'),
    );

    const res = await request(app).post('/api/extensions/installed/ext-fail/update');

    // The source keeps working on its previous version rather than going dark.
    expect(await fs.readFile(path.join(dir, 'bundle.js'), 'utf-8')).toBe('OLD BUNDLE');
    // Nothing was persisted, so the recorded version still matches what is on disk.
    expect(prismaMock.installed_extension.update).not.toHaveBeenCalled();
    // The staged file is cleaned up, not left as debris for the next attempt to trip over.
    await expect(fs.access(path.join(dir, 'bundle.next.js'))).rejects.toThrow();
    expect(res.status).toBeGreaterThanOrEqual(400);
    // Disposed even on the failure path — otherwise every check leaks a child process.
    expect(dispose).toHaveBeenCalled();
  });

  it('does not re-download a version that already failed this run', async () => {
    const dir = path.join(tmpBundlesDir, 'ext-retry');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'bundle.js'), 'OLD BUNDLE');

    mockExistingExtension('stale-hash-that-will-not-match', 'ext-retry');
    mockIndexFetch();
    mockBundleFetch('this bundle is broken');
    smokeTestGetFilters.mockRejectedValueOnce(new Error('load failed'));
    await request(app).post('/api/extensions/installed/ext-retry/update');

    const fetchCallsAfterFirst = vi.mocked(axios.get).mock.calls.length;

    // Second attempt at the same version: the index is still read, but the bundle is not
    // fetched again and the sandbox is not spawned again.
    mockExistingExtension('stale-hash-that-will-not-match', 'ext-retry');
    mockIndexFetch();
    const res = await request(app).post('/api/extensions/installed/ext-retry/update');

    expect(res.status).toBe(200);
    expect(res.body.data.changed).toBe(false);
    // One extra call only — the index — with no second bundle download.
    expect(vi.mocked(axios.get).mock.calls.length).toBe(fetchCallsAfterFirst + 1);
  });
});

describe('DELETE /api/extensions/installed/:id', () => {
  it('404s when the installed extension does not exist', async () => {
    prismaMock.installed_extension.findUnique.mockResolvedValueOnce(null);

    const res = await request(app).delete('/api/extensions/installed/does-not-exist');

    expect(res.status).toBe(404);
  });

  it('removes the DB row and its bundle directory', async () => {
    prismaMock.installed_extension.findUnique.mockResolvedValueOnce({ id: 'ext-1' });
    prismaMock.installed_extension.delete.mockResolvedValueOnce({ id: 'ext-1' });

    const bundleDir = path.join(tmpBundlesDir, 'ext-1');
    await fs.mkdir(bundleDir, { recursive: true });
    await fs.writeFile(path.join(bundleDir, 'bundle.js'), 'x');

    const res = await request(app).delete('/api/extensions/installed/ext-1');

    expect(res.status).toBe(200);
    await expect(fs.access(bundleDir)).rejects.toThrow();
  });
});

describe('POST /api/extensions/installed from an unsigned repository', () => {
  it('asks for acknowledgement before fetching anything', async () => {
    prismaMock.extension_repository.findUnique.mockResolvedValueOnce({
      id: 'repo-1',
      url: 'https://example.com/index.json',
    } as never);

    const res = await request(app)
      .post('/api/extensions/installed')
      .send({ repository_id: 'repo-1', source_key: 'test-source' });

    expect(res.status).toBe(409);
    expect(res.body.message).toContain('Unsigned repository');
    expect(axios.get).not.toHaveBeenCalled();
  });
});

describe('host-level routes from a remote client', () => {
  afterEach(() => {
    delete process.env.ADMIN_TOKEN;
  });

  it('rejects extension installs and restores from elsewhere once ADMIN_TOKEN is set', async () => {
    process.env.ADMIN_TOKEN = 'a-sixteen-char-token';
    const remote = { 'X-Forwarded-For': '203.0.113.9' };
    // supertest connects over loopback; TRUST_PROXY defaults to "loopback", so the
    // forwarded address becomes req.ip.
    const install = await request(app)
      .post('/api/extensions/installed')
      .set(remote)
      .send({ repository_id: 'repo-1', source_key: 'test-source' });
    const restore = await request(app).post('/api/restore/jobs').set(remote).send({});
    const directory = await request(app).get('/api/downloads/directory').set(remote);

    expect([install.status, restore.status, directory.status]).toEqual([403, 403, 403]);
  });
});
