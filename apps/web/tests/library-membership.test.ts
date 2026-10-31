import { afterEach, describe, expect, it, vi } from 'vitest';

const setMangaInLibrary = vi.fn();
vi.mock('@projekt-manga/api-client', async (original) => ({
  ...(await original<typeof import('@projekt-manga/api-client')>()),
  setMangaInLibrary: (id: string, inLibrary: boolean) => setMangaInLibrary(id, inLibrary),
}));

import { queryClient, queryKeys } from '@/lib/query-client';
import { setTitleInLibrary } from '@/lib/library-store';
import type { Manga } from '@/lib/manga-data';

const title = (id: string) => ({ id, title: id, inLibrary: true }) as Manga;
const cached = () =>
  (queryClient.getQueryData<Manga[]>(queryKeys.mangaLibrary) ?? []).map((manga) => manga.id);

afterEach(() => {
  queryClient.clear();
  setMangaInLibrary.mockReset();
});

describe('adding and removing library titles', () => {
  it('drops a removed title from the library at once, before the server answers', async () => {
    queryClient.setQueryData(queryKeys.mangaLibrary, [title('a'), title('b')]);
    let answer: () => void = () => undefined;
    setMangaInLibrary.mockReturnValue(new Promise<void>((resolve) => (answer = resolve)));

    const removing = setTitleInLibrary('a', false, { refresh: false });
    await vi.waitFor(() => expect(cached()).toEqual(['b']));
    answer();
    await removing;
    expect(setMangaInLibrary).toHaveBeenCalledWith('a', false);
    expect(cached()).toEqual(['b']);
  });

  it('puts the title back when the server refuses the removal', async () => {
    queryClient.setQueryData(queryKeys.mangaLibrary, [title('a'), title('b')]);
    setMangaInLibrary.mockRejectedValue(new Error('offline'));

    await expect(setTitleInLibrary('a', false, { refresh: false })).rejects.toThrow('offline');
    expect(cached().sort()).toEqual(['a', 'b']);
  });

  it('marks the library stale after a change, so every view refetches it', async () => {
    queryClient.setQueryData(queryKeys.mangaLibrary, [title('a')]);
    setMangaInLibrary.mockResolvedValue(undefined);
    await setTitleInLibrary('z', true);
    await vi.waitFor(() =>
      expect(queryClient.getQueryState(queryKeys.mangaLibrary)?.isInvalidated).toBe(true),
    );
  });
});
