import { afterEach, describe, expect, it, vi } from 'vitest';
import { addManga } from '../../../packages/api-client/src/manga';
import type { AddMangaPayload } from '@projekt-manga/types';

const payload: AddMangaPayload = {
  source: 'source-a',
  slug: 'read-before-add',
  title: 'Read Before Add',
  author: 'Unknown',
  thumbnail_url: 'https://example.com/cover.jpg',
  description: '',
  genres: '',
  status: 'ONGOING',
  chapters: [],
};

const serverEntry = {
  id: 'manga-1',
  source: payload.source,
  slug: payload.slug,
  title: payload.title,
  thumbnail_url: payload.thumbnail_url,
  author: 'Unknown',
  in_library: true,
  created_at: '2026-09-28T00:00:00Z',
  updated_at: '2026-09-28T00:00:00Z',
  chapter_count: 1,
  unread_count: 1,
  latest_chapter_date: null,
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  Reflect.deleteProperty(window, 'desktop');
});

describe('anonymous desktop manga add recovery', () => {
  it('repairs a stale local library after a previous server add returned 409', async () => {
    const invoke = vi.fn().mockResolvedValue({ success: true, message: '', data: true });
    Object.defineProperty(window, 'desktop', { configurable: true, value: { data: { invoke } } });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: false, message: 'Already added' }), { status: 409 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: [serverEntry] })));
    globalThis.fetch = fetchMock;

    await expect(addManga(payload)).resolves.toMatchObject({ id: 'manga-1' });
    expect(invoke).toHaveBeenCalledWith('manga', 'syncOne', { mangaId: 'manga-1' });
  });

  it('does not treat a different title conflict as a successful add', async () => {
    const invoke = vi.fn().mockResolvedValue({ success: true, message: '', data: true });
    Object.defineProperty(window, 'desktop', { configurable: true, value: { data: { invoke } } });
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: false, message: 'Already added' }), { status: 409 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ success: true, data: [{ ...serverEntry, slug: 'different-title' }] }),
        ),
      );

    await expect(addManga(payload)).rejects.toMatchObject({ status: 409 });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('does not report recovery until the local library was actually updated', async () => {
    const invoke = vi.fn().mockResolvedValue({ success: true, message: '', data: false });
    Object.defineProperty(window, 'desktop', { configurable: true, value: { data: { invoke } } });
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: false, message: 'Already added' }), { status: 409 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: [serverEntry] })));

    await expect(addManga(payload)).rejects.toMatchObject({ status: 409 });
    expect(invoke).toHaveBeenCalledWith('manga', 'syncOne', { mangaId: 'manga-1' });
  });

  it('preserves the normal 409 response in a plain browser', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ success: false, message: 'Already added' }), { status: 409 }),
      );
    globalThis.fetch = fetchMock;

    await expect(addManga(payload)).rejects.toMatchObject({ status: 409 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
