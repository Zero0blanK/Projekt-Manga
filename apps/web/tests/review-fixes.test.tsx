import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

// Source search paginates with opaque native cursors (searchSourceMangaPage), not offsets.
const { searchSourceMangaPage } = vi.hoisted(() => ({ searchSourceMangaPage: vi.fn() }));
vi.mock('@projekt-manga/api-client', () => ({ searchSourceMangaPage }));
vi.mock('@/lib/scroll', () => ({ useScrollBehavior: () => 'auto' }));
vi.mock('@/lib/report-error', () => ({ reportError: vi.fn() }));
// Stable objects, as React Query would return: a fresh object per render would re-run the
// carousel's search effect on every render.
const stable = vi.hoisted(() => ({
  capabilities: {
    capabilities: { search: true, languageFilter: false },
    error: null,
    retry: () => {},
  },
  filters: { filters: [] },
  language: ['all', () => {}] as const,
}));
vi.mock('@/lib/library-store', () => ({
  useSourceCapabilities: () => stable.capabilities,
  useSourceFilters: () => stable.filters,
}));
vi.mock('@/lib/source-display-language', () => ({
  useSourceDisplayLanguage: () => stable.language,
  sourceLanguageValues: () => ({}),
}));
vi.mock('@/components/discover/popular-section', () => ({
  SourceResultCard: ({ item }: { item: { title: string } }) => <span>{item.title}</span>,
}));

const { SourceSearchCarousel } = await import('@/components/discover/source-search-carousel');
const source = { id: 'source-a', name: 'Source A', accent: '#123456' } as never;
const rows = (prefix: string, count = 10) =>
  Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    title: `${prefix} ${index}`,
    source: 'source-a',
  }));

function scrollToEnd(container: HTMLElement) {
  const scroller = container.querySelector('.overflow-x-auto') as HTMLDivElement;
  Object.defineProperties(scroller, {
    scrollWidth: { configurable: true, value: 1500 },
    clientWidth: { configurable: true, value: 400 },
    scrollLeft: { configurable: true, value: 1100 },
  });
  fireEvent.scroll(scroller);
}

const cursorOf = (call: number) =>
  (searchSourceMangaPage.mock.calls[call][1] as { cursor?: string }).cursor;

beforeEach(() => vi.clearAllMocks());

describe('source search pagination recovery', () => {
  it('retries a failed later page with the same cursor without discarding results', async () => {
    searchSourceMangaPage
      .mockResolvedValueOnce({ items: rows('Title'), hasMore: true, nextCursor: 'page-2' })
      .mockRejectedValueOnce(new Error('temporary outage'))
      .mockResolvedValueOnce({
        items: [{ id: 'next', title: 'Next title', source: 'source-a' }],
        hasMore: false,
      });
    const { container } = render(<SourceSearchCarousel source={source} query="title" />);
    await screen.findByText('Title 0');
    scrollToEnd(container);
    const retry = await screen.findByRole('button', { name: /Could not load more results/ });
    expect(screen.getByText('Title 0')).toBeInTheDocument();
    fireEvent.click(retry);
    expect(await screen.findByText('Next title')).toBeInTheDocument();
    expect(screen.getByText('Title 9')).toBeInTheDocument();
    expect(cursorOf(1)).toBe('page-2');
    expect(cursorOf(2)).toBe('page-2');
  });

  it('treats a page of only repeated rows as stalled and retries the same cursor', async () => {
    searchSourceMangaPage
      .mockResolvedValueOnce({ items: rows('Title'), hasMore: true, nextCursor: 'page-2' })
      .mockResolvedValueOnce({ items: rows('Title'), hasMore: true, nextCursor: 'page-3' })
      .mockResolvedValueOnce({
        items: [{ id: 'after', title: 'After duplicates', source: 'source-a' }],
        hasMore: false,
      });
    const { container } = render(<SourceSearchCarousel source={source} query="title" />);
    await screen.findByText('Title 0');
    scrollToEnd(container);
    const retry = await screen.findByRole('button', { name: /Could not load more results/ });
    // The repeated page was not committed: no duplicate cards, and its cursor was not kept.
    expect(screen.getAllByText('Title 0')).toHaveLength(1);
    fireEvent.click(retry);
    expect(await screen.findByText('After duplicates')).toBeInTheDocument();
    await waitFor(() => expect(searchSourceMangaPage).toHaveBeenCalledTimes(3));
    expect(cursorOf(2)).toBe('page-2');
  });
});
