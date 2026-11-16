import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

// The router's pending state for a clicked link, as `useLinkStatus` reports it.
const link = vi.hoisted(() => ({ pending: false }));
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: ReactNode; href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
  useLinkStatus: () => ({ pending: link.pending }),
}));
vi.mock('@projekt-manga/api-client', () => ({ buildImageProxyUrl: (url: string) => url }));
vi.mock('@/lib/library-store', () => ({ useMangaLibrary: () => ({ manga: [] }) }));
vi.mock('@/components/discover/duplicate-manga-dialog', () => ({
  useDuplicateCheckedAdd: () => ({ requestAdd: vi.fn(), dialog: null }),
}));
vi.mock('@/components/cover', () => ({
  Cover: ({ alt }: { alt: string }) => <img alt={alt} />,
}));

const { SourceResultCard, SLOW_OPEN_MS } = await import('@/components/discover/popular-section');
const item = { id: 'frieren', title: 'Frieren', source: 'mangadex', thumbnail_url: null } as never;

afterEach(() => {
  cleanup();
  link.pending = false;
});

describe('a source card while its title page opens', () => {
  it('shows nothing extra until a click is waiting on the network', () => {
    render(<SourceResultCard sourceId="mangadex" item={item} />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('link', { name: 'Preview "Frieren"' })).not.toHaveAttribute(
      'aria-busy',
    );
  });

  it('says it is opening, then that the connection is slow', () => {
    vi.useFakeTimers();
    try {
      link.pending = true;
      render(<SourceResultCard sourceId="mangadex" item={item} />);
      expect(screen.getByRole('status')).toHaveTextContent('Opening…');
      expect(screen.getByRole('link', { name: 'Preview "Frieren"' })).toHaveAttribute(
        'aria-busy',
        'true',
      );

      act(() => vi.advanceTimersByTime(SLOW_OPEN_MS));
      expect(screen.getByRole('status')).toHaveTextContent('Slow connection, still opening');
    } finally {
      vi.useRealTimers();
    }
  });
});
