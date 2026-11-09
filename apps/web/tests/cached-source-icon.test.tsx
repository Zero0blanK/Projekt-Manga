import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { CachedSourceIcon } from '@/components/discover/cached-source-icon';
import { getCachedSourceIcon, resetSourceIconCache } from '@/lib/source-icon-cache';

const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'.repeat(
    2,
  );

function icon(url: string | null, key = 'manhuaus') {
  return (
    <CachedSourceIcon
      cacheKey={key}
      url={url}
      size={20}
      fallback={<span>MA</span>}
      frame={(img) => <span data-testid="framed">{img}</span>}
    />
  );
}

const imgSrc = (container: HTMLElement) =>
  container.querySelector('img')?.getAttribute('src') ?? null;

// Responses are built from strings with a Content-Type: jsdom's Blob is not the one the
// test runner's Response reads, and would arrive as the text "[object Blob]".
beforeEach(() => {
  resetSourceIconCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a source icon kept in the browser', () => {
  it('fetches an icon once, then shows it at once on later visits, even before its address is known', async () => {
    const fetchMock = vi.fn(
      async () => new Response(svg, { headers: { 'Content-Type': 'image/svg+xml' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    // A first visit shows the icon from its address at once, then the kept copy.
    const first = render(icon('/api/extensions/installed/1/icon'));
    expect(imgSrc(first.container)).toBe('/api/extensions/installed/1/icon');
    await waitFor(() => expect(imgSrc(first.container)).toMatch(/^data:image\/svg\+xml/));
    first.unmount();

    // The next visit: the installed list hasn't loaded, so there's no address yet.
    const second = render(icon(null));
    expect(imgSrc(second.container)).toMatch(/^data:image\/svg\+xml/);
    second.unmount();
    render(icon('/api/extensions/installed/1/icon'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the icon it has when a new address fails to load', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(svg, { headers: { 'Content-Type': 'image/svg+xml' } })),
    );
    const { unmount } = render(icon('/api/extensions/installed/1/icon'));
    await waitFor(() => expect(getCachedSourceIcon('manhuaus')).not.toBeNull());
    unmount();

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Too many requests', { status: 429 })),
    );
    const { container } = render(icon('/api/source/image-proxy?url=x'));
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(imgSrc(container)).toMatch(/^data:image\/svg\+xml/);
  });

  it('shows the letters for the image proxy’s empty placeholder', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(new Uint8Array(67), { headers: { 'Content-Type': 'image/png' } }),
      ),
    );
    render(icon('/api/source/image-proxy?url=icon.svg'));
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.getByText('MA')).toBeInTheDocument();
    expect(getCachedSourceIcon('manhuaus')).toBeNull();
  });
});
