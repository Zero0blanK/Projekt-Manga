import { afterEach, describe, expect, it, vi } from 'vitest';

const { cookies } = vi.hoisted(() => ({ cookies: vi.fn() }));
vi.mock('next/headers', () => ({ cookies }));

const { getRequestManga } = await import('@/lib/server-manga');
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.clearAllMocks();
});

const details = {
  id: 'manga-1',
  slug: 'manga-1',
  title: 'A title',
  author: 'Author',
  source: 'source-a',
  thumbnail_url: 'https://example.com/cover.jpg',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  status: 'ONGOING',
  genres: '',
  description: '',
  rating: null,
  artist: null,
  chapters: [],
};

describe('server-rendered manga progress account', () => {
  it('forwards only the session cookie to the API for a signed-in read', async () => {
    cookies.mockResolvedValue({ get: () => ({ value: 'session-token' }) });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ success: true, data: details })));
    globalThis.fetch = fetchMock;

    await expect(getRequestManga('manga-1')).resolves.toMatchObject({ id: 'manga-1' });
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      headers: { Cookie: 'pm_session=session-token' },
      cache: 'no-store',
    });
  });

  it('does not invent a session for an anonymous read', async () => {
    cookies.mockResolvedValue({ get: () => undefined });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ success: true, data: details })));
    globalThis.fetch = fetchMock;

    await getRequestManga('manga-1');
    expect(fetchMock.mock.calls[0][1].headers).toBeUndefined();
  });
});
