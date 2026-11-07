import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useChapterPages, useLoadedPage } from '@/components/reader/use-chapter-pages';

const release = (id: string) => ({ id });

describe('useChapterPages', () => {
  it('shows pages only for the chapter they were fetched for', async () => {
    const load = vi.fn(async ({ id }: { id: string }) => [`${id}.jpg`]);
    const { result, rerender } = renderHook(
      ({ chapter, id }) => useChapterPages({ chapter, record: release(id), enabled: true, load }),
      { initialProps: { chapter: 1, id: 'a' } },
    );
    await waitFor(() => expect(result.current.pageUrls).toEqual(['a.jpg']));

    rerender({ chapter: 2, id: 'b' });

    expect(result.current.pageUrls).toEqual([]);
    await waitFor(() => expect(result.current.pageUrls).toEqual(['b.jpg']));
  });

  it('asks a source once, however many callers want the same chapter', async () => {
    const load = vi.fn(async () => ['page.jpg']);
    const { result } = renderHook(() =>
      useChapterPages({ chapter: 1, record: release('a'), enabled: true, load }),
    );
    await waitFor(() => expect(result.current.pageUrls).toHaveLength(1));

    await act(async () => {
      await Promise.all([
        result.current.pagesFor(release('b')),
        result.current.pagesFor(release('b')),
      ]);
      await result.current.pagesFor(release('b'));
    });

    expect(load).toHaveBeenCalledTimes(2);
  });

  it('forgets a failure, so a retry really asks again', async () => {
    const load = vi
      .fn<() => Promise<string[]>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(['page.jpg']);
    const { result } = renderHook(() =>
      useChapterPages({ chapter: 1, record: release('a'), enabled: true, load }),
    );
    await waitFor(() => expect(result.current.pagesError).toBe(true));

    act(() => result.current.retryPages());

    await waitFor(() => expect(result.current.pageUrls).toEqual(['page.jpg']));
    expect(result.current.pagesError).toBe(false);
  });

  it('reports an error when the chapter list has no such chapter', async () => {
    const { result } = renderHook(() =>
      useChapterPages({ chapter: 9, record: undefined, enabled: true, load: vi.fn() }),
    );

    await waitFor(() => expect(result.current.pagesError).toBe(true));
  });
});

describe('useLoadedPage', () => {
  it('turns ready when the page on screen loads, and ignores others', () => {
    const { result, rerender } = renderHook(({ page }) => useLoadedPage('a', page), {
      initialProps: { page: 1 },
    });

    act(() => result.current.markPageLoaded('a', 2));
    expect(result.current.imageReady).toBe(false);

    act(() => result.current.markPageLoaded('a', 1));
    expect(result.current.imageReady).toBe(true);

    rerender({ page: 2 });
    expect(result.current.imageReady).toBe(true);
  });
});
