import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useNextChapterPreload } from '@/components/reader/use-next-chapter-preload';

type Options = Parameters<typeof useNextChapterPreload>[0];

const pages = (count: number) => Array.from({ length: count }, (_, i) => `page-${i + 1}`);
/** Chapters 1…5 in order. */
const nextChapterAfter = (chapter: number) => (chapter < 5 ? chapter + 1 : null);

let warmed: string[];
const OriginalImage = window.Image;

beforeEach(() => {
  warmed = [];
  window.Image = class {
    set src(url: string) {
      warmed.push(url);
    }
  } as never;
});
afterEach(() => {
  window.Image = OriginalImage;
});

const preload = (options: Partial<Options>) => {
  const fetchPages = vi.fn(async (chapter: number) => [
    `ch${chapter}-first`,
    `ch${chapter}-second`,
  ]);
  const view = renderHook((props: Options) => useNextChapterPreload(props), {
    initialProps: {
      enabled: true,
      chapter: 1,
      page: 1,
      pageUrls: pages(10),
      pagePrefetchAhead: 2,
      chapterPrefetchCount: 1,
      nextChapterAfter,
      fetchPages,
      ...options,
    },
  });
  return { fetchPages, ...view };
};

describe('warming the next chapter', () => {
  it('waits until the reader is near the end of the chapter', async () => {
    const { fetchPages, rerender } = preload({ page: 7 });
    expect(fetchPages).not.toHaveBeenCalled();

    rerender({
      enabled: true,
      chapter: 1,
      page: 8,
      pageUrls: pages(10),
      pagePrefetchAhead: 2,
      chapterPrefetchCount: 1,
      nextChapterAfter,
      fetchPages,
    });
    await waitFor(() => expect(warmed).toEqual(['ch2-first']));
    expect(fetchPages).toHaveBeenCalledTimes(1);
    expect(fetchPages).toHaveBeenCalledWith(2);
  });

  it("does nothing until the current chapter's own pages have loaded", () => {
    const { fetchPages } = preload({ page: 1, pageUrls: [] });
    expect(fetchPages).not.toHaveBeenCalled();
  });

  it('does nothing when turned off', () => {
    const { fetchPages } = preload({ enabled: false, page: 10 });
    expect(fetchPages).not.toHaveBeenCalled();
  });

  it('does nothing on the last chapter', () => {
    const { fetchPages } = preload({ chapter: 5, page: 10 });
    expect(fetchPages).not.toHaveBeenCalled();
  });

  it('walks as many chapters forward as asked, one at a time and in order', async () => {
    const started: number[] = [];
    let inFlight = 0;
    let overlapped = false;
    const fetchPages = vi.fn(async (chapter: number) => {
      started.push(chapter);
      if (++inFlight > 1) overlapped = true;
      await Promise.resolve();
      inFlight--;
      return [`ch${chapter}-first`];
    });
    preload({ page: 10, chapterPrefetchCount: 3, fetchPages });
    await waitFor(() => expect(warmed).toEqual(['ch2-first', 'ch3-first', 'ch4-first']));
    expect(started).toEqual([2, 3, 4]);
    expect(overlapped).toBe(false);
  });

  it('stops at a chapter it cannot load rather than pressing on', async () => {
    const fetchPages = vi.fn(async (chapter: number) => {
      if (chapter === 3) throw new Error('source is down');
      return [`ch${chapter}-first`];
    });
    preload({ page: 10, chapterPrefetchCount: 3, fetchPages });
    await waitFor(() => expect(fetchPages).toHaveBeenCalledWith(3));
    await Promise.resolve();
    expect(warmed).toEqual(['ch2-first']);
    expect(fetchPages).not.toHaveBeenCalledWith(4);
  });

  it('abandons the walk when the reader moves on', async () => {
    let release!: () => void;
    const fetchPages = vi.fn(
      (chapter: number) =>
        new Promise<string[]>((resolve) => {
          release = () => resolve([`ch${chapter}-first`]);
        }),
    );
    const { unmount } = preload({ page: 10, fetchPages });
    unmount();
    release();
    await Promise.resolve();
    expect(warmed).toEqual([]);
  });
});
