import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { searchSourceMangaPage } = vi.hoisted(() => ({ searchSourceMangaPage: vi.fn() }));
vi.mock('@projekt-manga/api-client', () => ({ searchSourceMangaPage }));
vi.mock('@/lib/scroll', () => ({ useScrollBehavior: () => 'auto' }));
vi.mock('@/lib/library-store', () => ({
  useSourceFilters: () => ({ filters: [] }),
  useSourceCapabilities: () => ({ capabilities }),
}));
vi.mock('@/lib/source-display-language', () => ({
  useSourceDisplayLanguage: () => ['all', vi.fn()],
  sourceLanguageValues: () => ({}),
}));
vi.mock('@/components/discover/popular-section', () => ({
  SourceResultCard: ({ item }: { item: { title: string } }) => <span>{item.title}</span>,
}));

const capabilities = { search: true, languageFilter: false };
const { SourceSearchCarousel } = await import('@/components/discover/source-search-carousel');
const source = { id: 'source-a', name: 'Source A', accent: '#123456' } as never;

beforeEach(() => vi.clearAllMocks());

describe('Source search retry', () => {
  it('renders repeated first-page and later-page cards once without duplicate-key warnings and keeps the upstream cursor', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const one = { id: 'one', title: 'Repeated title', source: 'source-a' };
      searchSourceMangaPage
        .mockResolvedValueOnce({
          hasMore: true,
          nextCursor: 'upstream-page-2',
          items: [
            one,
            one,
            ...Array.from({ length: 8 }, (_, i) => ({
              id: `initial-${i}`,
              title: `Initial ${i}`,
              source: 'source-a',
            })),
          ],
        })
        .mockResolvedValueOnce({
          hasMore: false,
          items: [
            one,
            { id: 'new', title: 'New title', source: 'source-a' },
            { id: 'new', title: 'New title', source: 'source-a' },
          ],
        });
      const view = render(<SourceSearchCarousel source={source} query="duplicate" />);
      await screen.findByText('Repeated title');
      expect(screen.getAllByText('Repeated title')).toHaveLength(1);
      const rail = view.container.querySelector<HTMLDivElement>('.overflow-x-auto')!;
      Object.defineProperties(rail, {
        scrollWidth: { value: 900 },
        clientWidth: { value: 300 },
        scrollLeft: { value: 800 },
      });
      fireEvent.scroll(rail);
      await screen.findByText('New title');
      expect(screen.getAllByText('New title')).toHaveLength(1);
      expect(screen.getAllByText('Repeated title')).toHaveLength(1);
      await waitFor(() => expect(searchSourceMangaPage).toHaveBeenCalledTimes(2));
      expect(searchSourceMangaPage.mock.calls[1][1].cursor).toBe('upstream-page-2');
      expect(error.mock.calls.some((call) => String(call[0]).includes('same key'))).toBe(false);
    } finally {
      error.mockRestore();
    }
  });
  it('retries only the failed source with the same query', async () => {
    searchSourceMangaPage
      .mockRejectedValueOnce(new Error('source unavailable'))
      .mockResolvedValueOnce({
        items: [{ id: 'one', title: 'Found title', source: 'source-a' }],
        hasMore: false,
      });

    render(<SourceSearchCarousel source={source} query="found" />);
    expect(await screen.findByText(/couldn't be reached for this search/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Found title')).toBeInTheDocument();
    expect(searchSourceMangaPage).toHaveBeenCalledTimes(2);
    expect(searchSourceMangaPage.mock.calls[0][1]).toEqual(searchSourceMangaPage.mock.calls[1][1]);
  });
});
