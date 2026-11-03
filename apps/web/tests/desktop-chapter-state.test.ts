import { afterEach, describe, expect, it, vi } from 'vitest';
import { getMangaChapters } from '../../../packages/api-client/src/chapter';
import { refreshLocalDataMode } from '../../../packages/api-client/src/runtime';
import { signedInBridge } from './helpers/signed-in-desktop';

const originalFetch = globalThis.fetch;

afterEach(async () => {
  globalThis.fetch = originalFetch;
  Reflect.deleteProperty(window, 'desktop');
  await refreshLocalDataMode();
});

describe('manga chapter state transport', () => {
  it('reads desktop-local progress rather than the stale server chapter list', async () => {
    const localChapters = [{ id: 'chapter-3', last_page_read: 7, page_count: 10 }];
    const invoke = vi.fn().mockResolvedValue({
      success: true,
      data: { id: 'manga-1', chapters: localChapters },
    });
    Object.defineProperty(window, 'desktop', {
      configurable: true,
      value: { data: { invoke: signedInBridge(invoke) } },
    });
    await refreshLocalDataMode();
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    await expect(getMangaChapters('manga-1', 'slug-1', 'source-a')).resolves.toEqual(localChapters);
    expect(invoke).toHaveBeenCalledWith('manga', 'getDetails', { mangaId: 'manga-1' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads the server on a desktop with no account, like a browser on the same server', async () => {
    // Without an account the library is the server's shared one; a local copy would split
    // the app from every browser that opens the same library.
    const invoke = vi.fn().mockResolvedValue({ success: true, data: { localFirst: false } });
    Object.defineProperty(window, 'desktop', { configurable: true, value: { data: { invoke } } });
    await refreshLocalDataMode();
    const serverChapters = [{ id: 'chapter-3', last_page_read: 4, page_count: 10 }];
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ success: true, data: serverChapters })));
    globalThis.fetch = fetchMock;

    await expect(getMangaChapters('manga-1', 'slug-1', 'source-a')).resolves.toEqual(
      serverChapters,
    );
    expect(invoke).toHaveBeenCalledWith('meta', 'mode');
    expect(invoke).not.toHaveBeenCalledWith('manga', 'getDetails', expect.anything());
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
    Object.defineProperty(window, 'desktop', {
      configurable: true,
      value: { data: { invoke: signedInBridge(invoke) } },
    });
    await refreshLocalDataMode();
    const chapters = [{ id: 'chapter-3', last_page_read: 4, page_count: 10 }];
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ success: true, data: chapters })));

    await expect(getMangaChapters('manga-1', 'slug-1', 'source-a')).resolves.toEqual(chapters);
  });
});
