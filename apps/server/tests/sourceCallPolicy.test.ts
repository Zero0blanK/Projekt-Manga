import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const fakeSource = {
  id: 'fake-source',
  name: 'Fake Source',
  lang: 'en',
  base_url: 'https://fake.example',
  isNSFW: false,
  fetchManga: vi.fn(async () => []),
  searchManga: vi.fn(async () => []),
  fetchMangaDetails: vi.fn(),
  fetchChapters: vi.fn(async () => []),
  fetchChapterPages: vi.fn(),
  getFilters: vi.fn(async () => []),
  fetchMangaUpdates: vi.fn(async () => []),
};

vi.mock('../src/services/sandboxedSourceRegistry.service.js', () => ({
  getInstalledSandboxedSources: vi.fn(async () => [fakeSource]),
  getInstalledSandboxedSource: vi.fn(async (id: string) =>
    id === fakeSource.id ? fakeSource : undefined,
  ),
}));

const { default: verifiedSource } = await import('../src/services/verifiedSource.service.js');
const { getSourceHealthSnapshot, resetSourceHealthForTests } =
  await import('../src/services/sourceHealth.service.js');
const { ServiceUnavailableError, UpstreamError, RateLimitedError } =
  await import('../src/utils/customErrors.js');

const browseHealth = () =>
  getSourceHealthSnapshot().find((source) => source.sourceId === 'fake-source')?.browse;

beforeEach(() => {
  resetSourceHealthForTests();
  fakeSource.fetchChapterPages.mockReset();
});

describe('a call into a source', () => {
  it('returns the checked result and records the success', async () => {
    fakeSource.fetchChapterPages.mockResolvedValueOnce({
      items: [{ index: 0, image_url: 'https://fake.example/1.jpg' }],
      total: 1,
    });
    const pages = await verifiedSource.getChapterPages('fake-source', 'ch-1', 'slug');
    expect(pages.items).toHaveLength(1);
    expect(browseHealth()?.lastErrorCode).toBeNull();
    expect(browseHealth()?.lastSuccessAt).not.toBeNull();
  });

  it('refuses output it cannot read, and the failure shows in source health', async () => {
    fakeSource.fetchChapterPages.mockResolvedValueOnce({ items: 'not a list' });
    await expect(verifiedSource.getChapterPages('fake-source', 'ch-1')).rejects.toBeInstanceOf(
      UpstreamError,
    );
    expect(browseHealth()?.lastSuccessAt).toBeNull();
    expect(browseHealth()?.lastErrorCode).not.toBeNull();
  });

  it("turns the source's own error into one the API can answer with", async () => {
    fakeSource.fetchChapterPages.mockRejectedValueOnce({
      code: 'RATE_LIMITED',
      message: 'Slow down',
      reason: 'retry after 30s',
    });
    await expect(verifiedSource.getChapterPages('fake-source', 'ch-1')).rejects.toBeInstanceOf(
      RateLimitedError,
    );
    expect(browseHealth()?.lastErrorCode).toBe('RATE_LIMITED');
    expect(browseHealth()?.retryAfterAt).not.toBeNull();
  });

  it('answers the same way for a source that is not installed, without a health record', async () => {
    await expect(verifiedSource.getChapterPages('gone', 'ch-1')).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );
    await expect(verifiedSource.requireSource('gone')).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );
    expect(getSourceHealthSnapshot()).toEqual([]);
  });
});

describe('the raw source', () => {
  // The checks above only hold while every caller goes through verifiedSource.service.ts.
  // A second importer of the resolver or the registries' lookups would be a way around.
  const src = fileURLToPath(new URL('../src', import.meta.url));
  const files = (readdirSync(src, { recursive: true }) as string[])
    .filter((name) => name.endsWith('.ts'))
    .map((name) => join(src, name));
  const importers = (pattern: RegExp) =>
    files
      .filter((file) => pattern.test(readFileSync(file, 'utf8')))
      .map((file) => relative(src, file).replaceAll('\\', '/'))
      .sort();

  it('is resolved only by the verified source module', () => {
    expect(importers(/from '.*sourceResolver\.service\.js'/)).toEqual([
      'services/verifiedSource.service.ts',
    ]);
  });

  it('is looked up by key only by the resolver', () => {
    expect(
      importers(/import [^;]*\b(getInstalledSandboxedSource|getSuwayomiSource)\b[^;]*;/),
    ).toEqual(['services/sourceResolver.service.ts']);
  });
});
