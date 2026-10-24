import { render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DisplaySource } from '@/lib/manga-data';
const state = vi.hoisted(() => ({
  languages: { a: 'en', b: 'all' } as Record<string, string>,
  search: vi.fn().mockResolvedValue({ items: [], hasMore: false }),
  filters: [
    {
      type: 'select',
      value: 'language',
      options: [
        { value: 'en', label: 'English' },
        { value: 'ja', label: 'Japanese' },
      ],
    },
  ],
}));
vi.mock('@projekt-manga/api-client', () => ({ searchSourceMangaPage: state.search }));
vi.mock('@/lib/library-store', () => ({
  useSourceFilters: () => ({ filters: state.filters }),
  useSourceCapabilities: () => ({ capabilities }),
}));
vi.mock('@/lib/source-display-language', async (original) => ({
  ...(await original<typeof import('@/lib/source-display-language')>()),
  useSourceDisplayLanguage: (id: string) => [state.languages[id] ?? 'all'],
}));
vi.mock('@/lib/scroll', () => ({ useScrollBehavior: () => 'auto' }));
vi.mock('@/components/discover/popular-section', () => ({ SourceResultCard: () => null }));
const capabilities = { search: true, languageFilter: true };
import { SourceSearchCarousel } from '@/components/discover/source-search-carousel';
describe('source language search requests', () => {
  it('applies and changes only the chosen source language', async () => {
    const source = (id: string) =>
      ({ id, name: id, lang: 'all', accent: '#123456' }) as DisplaySource;
    const View = () => (
      <>
        <SourceSearchCarousel source={source('a')} query="fixture" />
        <SourceSearchCarousel source={source('b')} query="fixture" />
      </>
    );
    const view = render(<View />);
    await waitFor(() => expect(state.search).toHaveBeenCalledTimes(2));
    expect(state.search.mock.calls.find((call) => call[0] === 'a')[1].filters).toEqual({
      language: 'en',
    });
    expect(state.search.mock.calls.find((call) => call[0] === 'b')[1].filters).toEqual({});
    state.languages.a = 'ja';
    view.rerender(<View />);
    await waitFor(() => expect(state.search).toHaveBeenCalledTimes(3));
    expect(state.search.mock.calls[2][0]).toBe('a');
    expect(state.search.mock.calls[2][1].filters).toEqual({ language: 'ja' });
  });
});
