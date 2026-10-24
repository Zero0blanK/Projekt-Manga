import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-client';
import {
  clearStaticDataCache,
  persistStaticDataCache,
  restoreStaticDataCache,
  STATIC_DATA_STALE_TIME,
  useWarmStartupStaticData,
} from '@/lib/startup-static-data';

const { getSources, listExtensionRepositories, listInstalledExtensions } = vi.hoisted(() => ({
  getSources: vi.fn(),
  listExtensionRepositories: vi.fn(),
  listInstalledExtensions: vi.fn(),
}));
vi.mock('@projekt-manga/api-client', () => ({
  getSources,
  listExtensionRepositories,
  listInstalledExtensions,
}));

const source = {
  id: 'catalogue',
  name: 'Catalogue',
  lang: 'en',
  base_url: 'https://catalogue.example',
  isNSFW: false,
};

const storageValues = new Map<string, string>();
const storageMock: Storage = {
  get length() {
    return storageValues.size;
  },
  clear: () => storageValues.clear(),
  getItem: (key) => storageValues.get(key) ?? null,
  key: (index) => Array.from(storageValues.keys())[index] ?? null,
  removeItem: (key) => storageValues.delete(key),
  setItem: (key, value) => storageValues.set(key, value),
};

function createClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

beforeEach(() => {
  storageMock.clear();
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storageMock });
});

describe('startup static-data cache', () => {
  it('restores a validated source list with its original query timestamp', () => {
    const writer = createClient();
    writer.setQueryData(queryKeys.sources, [source]);
    const savedAt = writer.getQueryState(queryKeys.sources)?.dataUpdatedAt;
    persistStaticDataCache(writer);

    const reader = createClient();
    restoreStaticDataCache(reader);

    expect(reader.getQueryData(queryKeys.sources)).toEqual([source]);
    expect(reader.getQueryState(queryKeys.sources)?.dataUpdatedAt).toBe(savedAt);
  });

  it('never restores data after the snapshot is cleared by an extension mutation', () => {
    const writer = createClient();
    writer.setQueryData(queryKeys.sources, [source]);
    persistStaticDataCache(writer);
    clearStaticDataCache();

    const reader = createClient();
    restoreStaticDataCache(reader);

    expect(reader.getQueryData(queryKeys.sources)).toBeUndefined();
  });

  it('rechecks installed sources at startup so an install made elsewhere appears', async () => {
    const elsewhere = { ...source, id: 'installed-elsewhere', name: 'Installed elsewhere' };
    getSources.mockReset().mockResolvedValue([source, elsewhere]);
    listExtensionRepositories.mockReset().mockResolvedValue([]);
    listInstalledExtensions.mockReset().mockResolvedValue([]);

    const client = createClient();
    // Saved two minutes ago: still a valid snapshot to render, but no longer trusted.
    client.setQueryData(queryKeys.sources, [source], { updatedAt: Date.now() - 2 * 60_000 });
    client.setQueryData(queryKeys.extensionRepositories, [], { updatedAt: Date.now() });
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);

    const { result, unmount } = renderHook(() => useWarmStartupStaticData(), { wrapper });
    await vi.waitFor(() => expect(result.current).toBe(true));

    expect(getSources).toHaveBeenCalled();
    expect(listExtensionRepositories).not.toHaveBeenCalled();
    expect(client.getQueryData(queryKeys.sources)).toEqual([source, elsewhere]);
    unmount();
  });

  it('backs off after an expired cached query fails instead of retrying every second', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
      getSources.mockReset().mockRejectedValue(new Error('offline'));
      listExtensionRepositories.mockReset().mockRejectedValue(new Error('offline'));
      listInstalledExtensions.mockReset().mockRejectedValue(new Error('offline'));

      const client = createClient();
      const expiredAt = Date.now() - STATIC_DATA_STALE_TIME - 1;
      client.setQueryData(queryKeys.sources, [source], { updatedAt: expiredAt });
      client.setQueryData(queryKeys.extensionRepositories, [], { updatedAt: expiredAt });
      client.setQueryData(queryKeys.installedExtensions, [], { updatedAt: expiredAt });
      const wrapper = ({ children }: { children: React.ReactNode }) =>
        createElement(QueryClientProvider, { client }, children);

      const { unmount } = renderHook(() => useWarmStartupStaticData(), { wrapper });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(getSources).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(getSources).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5 * 60_000);
      });
      expect(getSources).toHaveBeenCalledTimes(2);
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});
