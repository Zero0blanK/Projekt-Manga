import { afterEach, describe, expect, it, vi } from 'vitest';
import { getMangaChapters } from '../../../packages/api-client/src/chapter';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  Reflect.deleteProperty(window, 'desktop');
});

describe('manga chapter state transport', () => {
  it('reads desktop-local progress rather than the stale server chapter list', async () => {
    const localChapters = [{ id: 'chapter-3', last_page_read: 7, page_count: 10 }];
    const invoke = vi.fn().mockResolvedValue({
      success: true,
      data: { id: 'manga-1', chapters: localChapters },
    });
    Object.defineProperty(window, 'desktop', { configurable: true, value: { data: { invoke } } });
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    await expect(getMangaChapters('manga-1', 'slug-1', 'source-a')).resolves.toEqual(localChapters);
    expect(invoke).toHaveBeenCalledWith('manga', 'getDetails', { mangaId: 'manga-1' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the HTTP chapter list in a plain browser', async () => {
    const serverChapters = [{ id: 'chapter-3', last_page_read: 4, page_count: 10 }];
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ success: true, data: serverChapters })));
    globalThis.fetch = fetchMock;

    await expect(getMangaChapters('manga-1', 'slug-1', 'source-a')).resolves.toEqual(
      serverChapters,
    );
    expect(String(fetchMock.mock.calls[0][0])).toContain('/chapter/slug-1?source=source-a');
  });

  it('falls back to the server when the desktop cache has not seeded this title', async () => {
    const invoke = vi.fn().mockResolvedValue({ success: true, data: null });
    Object.defineProperty(window, 'desktop', { configurable: true, value: { data: { invoke } } });
    const chapters = [{ id: 'chapter-3', last_page_read: 4, page_count: 10 }];
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ success: true, data: chapters })));

    await expect(getMangaChapters('manga-1', 'slug-1', 'source-a')).resolves.toEqual(chapters);
  });
});
