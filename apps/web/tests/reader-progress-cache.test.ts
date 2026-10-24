import { afterEach, describe, expect, it } from 'vitest';
import { invalidateSavedReadingProgress, queryClient, queryKeys } from '@/lib/query-client';

describe('saved reading progress cache', () => {
  afterEach(() => queryClient.removeQueries({ queryKey: queryKeys.mangaLibrary }));

  it('marks a fresh library listing stale after a reader write', async () => {
    queryClient.setQueryData(queryKeys.mangaLibrary, [{ id: 'manga-1', progress: 0 }]);
    expect(queryClient.getQueryState(queryKeys.mangaLibrary)?.isInvalidated).toBe(false);

    invalidateSavedReadingProgress();

    expect(queryClient.getQueryState(queryKeys.mangaLibrary)?.isInvalidated).toBe(true);
  });
});
