import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';

const api = vi.hoisted(() => ({ getManga: vi.fn() }));
vi.mock('@projekt-manga/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@projekt-manga/api-client')>()),
  getManga: api.getManga,
}));
const saved = vi.hoisted(() => ({ showing: false }));
vi.mock('@/lib/offline-library', () => ({
  isShowingSavedLibrary: () => saved.showing,
  isLibraryFilling: () => false,
  setLibraryFilling: () => {},
}));

import { fetchLibraryProgressively } from '@/lib/library-store';
import { queryKeys } from '@/lib/query-client';

const item = (id: string) => ({ id, slug: id, title: id, source: 's', thumbnail_url: '' });

/** A server that sends two pages and reports the first one as it lands. */
function twoPages(seenDuring: (client: QueryClient) => void, client: QueryClient) {
  api.getManga.mockImplementation(
    async (
      _options: unknown,
      _signal: AbortSignal,
      progress?: { onPage?: (s: unknown[]) => void },
    ) => {
      progress?.onPage?.([item('a')]);
      seenDuring(client);
      return [item('a'), item('b')];
    },
  );
}

const ids = (client: QueryClient) =>
  client.getQueryData<{ id: string }[]>(queryKeys.mangaLibrary)?.map((m) => m.id);

beforeEach(() => {
  api.getManga.mockReset();
  saved.showing = false;
});

describe('loading the library', () => {
  it('shows each page as it lands the first time, starting small', async () => {
    const client = new QueryClient();
    let midway: string[] | undefined;
    twoPages((c) => (midway = ids(c)), client);

    const all = await fetchLibraryProgressively(client, new AbortController().signal);

    expect(midway).toEqual(['a']);
    expect(all.map((m) => m.id)).toEqual(['a', 'b']);
    expect(api.getManga.mock.calls[0][2]).toMatchObject({ firstPageSize: 60 });
  });

  it("keeps a library that's already showing until the whole list is back", async () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.mangaLibrary, [item('x'), item('y'), item('z')]);
    api.getManga.mockResolvedValue([item('a'), item('b')]);

    await fetchLibraryProgressively(client, new AbortController().signal);

    expect(api.getManga.mock.calls[0][2]?.onPage).toBeUndefined();
  });

  it("doesn't shrink the saved copy to a first page", async () => {
    const client = new QueryClient();
    saved.showing = true;
    let midway: string[] | undefined;
    twoPages((c) => (midway = ids(c)), client);

    await fetchLibraryProgressively(client, new AbortController().signal);

    expect(midway).toBeUndefined();
  });

  it('drops the pages of a request that was cancelled', async () => {
    const client = new QueryClient();
    const controller = new AbortController();
    let midway: string[] | undefined;
    api.getManga.mockImplementation(
      async (_o: unknown, _s: AbortSignal, progress?: { onPage?: (s: unknown[]) => void }) => {
        controller.abort();
        progress?.onPage?.([item('a')]);
        midway = ids(client);
        return [item('a')];
      },
    );

    await fetchLibraryProgressively(client, controller.signal);

    expect(midway).toBeUndefined();
  });
});
