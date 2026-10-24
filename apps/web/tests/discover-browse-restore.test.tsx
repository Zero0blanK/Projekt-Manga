import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
vi.mock('@/lib/extensions-store', () => ({ useInstalledExtensions: () => ({ installed: [] }) }));
vi.mock('@/lib/source-display-language', () => ({
  useSourceDisplayLanguage: () => ['all', vi.fn()],
  sourceLanguageValues: () => ({}),
}));
vi.mock('@/components/discover/content-privacy', () => ({
  useContentPrivacy: () => [{ hideAdult: false }],
  isAdultSource: (rating: string | undefined, adult: boolean) =>
    rating === 'nsfw' || (!rating && adult),
}));

const {
  readBrowseSnapshot,
  saveBrowseSnapshot,
  useSourceBrowsePaged,
  getRequestedSource,
  capabilityState,
} = vi.hoisted(() => ({
  capabilityState: { search: true, filters: true, latest: true },
  readBrowseSnapshot: vi.fn(),
  saveBrowseSnapshot: vi.fn(),
  useSourceBrowsePaged: vi.fn(),
  getRequestedSource: vi.fn<() => string | null>(),
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () =>
    new URLSearchParams(getRequestedSource() ? `source=${getRequestedSource()}` : ''),
}));
vi.mock('@/lib/browse-state', () => ({
  readBrowseSnapshot,
  saveBrowseSnapshot,
}));
vi.mock('@/lib/library-store', () => ({
  useSources: () => ({
    sources: [
      { id: 'source-a', name: 'A', lang: 'en', base_url: 'https://a.example', isNSFW: false },
      { id: 'source-b', name: 'B', lang: 'en', base_url: 'https://b.example', isNSFW: false },
    ],
  }),
  useSourceFilters: () => ({ filters: [] }),
  useSourceCapabilities: () => ({ capabilities: capabilityState }),
  useSourceBrowsePaged,
}));
vi.mock('@/components/discover/popular-section', () => ({
  SourceResultCard: ({ item }: { item: { title: string } }) => <span>{item.title}</span>,
}));
vi.mock('@/components/manga-grid', () => ({
  MangaGrid: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const { DiscoverBrowsePage } = await import('@/components/discover/browse-page');
const Icon = () => <span />;

function page() {
  return (
    <DiscoverBrowsePage
      browseKey="popular"
      category="popular"
      icon={Icon}
      emptyIcon={Icon}
      defaultTitle="Popular"
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(capabilityState, { search: true, filters: true, latest: true });
  getRequestedSource.mockReturnValue(null);
  readBrowseSnapshot.mockReturnValue(null);
  useSourceBrowsePaged.mockReturnValue({
    items: [],
    loading: false,
    loadingMore: false,
    hasMore: false,
    loadMore: vi.fn(),
    error: null,
    retry: vi.fn(),
  });
});

describe('Discover browse state', () => {
  it("keeps the reader's scroll position when the router scrolls to the top for the next page", async () => {
    const items = [{ id: 'title-1', title: 'Title 1', source: 'source-a' }];
    useSourceBrowsePaged.mockReturnValue({
      items,
      itemsQueryIdentity: JSON.stringify(['source-a', 'popular', '{}', '']),
      loading: false,
      loadingMore: false,
      hasMore: false,
      loadMore: vi.fn(),
      error: null,
      retry: vi.fn(),
    });
    window.history.replaceState(null, '', '/discover/popular');
    const scrollTo = (y: number) => {
      Object.defineProperty(window, 'scrollY', { configurable: true, value: y });
      fireEvent.scroll(window);
    };
    const view = render(page());
    await screen.findByText('Title 1');
    scrollTo(2400);
    // Opening a title: the URL changes first, then Next scrolls to the top while this page
    // is still mounted, and only then is it unmounted.
    window.history.pushState(null, '', '/discover/preview/source-a/title-1');
    scrollTo(0);
    view.unmount();
    expect(saveBrowseSnapshot.mock.calls.at(-1)?.[1]).toMatchObject({ scrollY: 2400 });
    window.history.replaceState(null, '', '/');
    scrollTo(0);
  });

  it('hides unsupported search and does not fetch unsupported latest listings', async () => {
    Object.assign(capabilityState, { search: false, filters: false, latest: false });
    render(
      <DiscoverBrowsePage
        browseKey="latest"
        category="latest"
        icon={Icon}
        emptyIcon={Icon}
        defaultTitle="Latest"
      />,
    );
    expect(
      screen.queryByRole('textbox', { name: 'Search all titles on this source' }),
    ).not.toBeInTheDocument();
    await screen.findByText(/does not support latest listings/);
    expect(useSourceBrowsePaged.mock.calls.at(-1)?.[0]).toBeNull();
    expect(screen.queryByText('No titles match these filters.')).not.toBeInTheDocument();
  });
  it('restores matching source results and filters after sources load', async () => {
    readBrowseSnapshot.mockReturnValue({
      sourceId: 'source-a',
      query: '',
      sortValue: '',
      filterValues: { status: 'ongoing' },
      items: [{ id: 'saved-title', title: 'Saved title', source: 'source-a' }],
      hasMore: true,
      scrollY: 0,
      savedAt: Date.now(),
    });

    render(page());

    await waitFor(() => {
      const calls = useSourceBrowsePaged.mock.calls;
      expect(calls.at(-1)?.[0]).toBe('source-a');
      expect(calls.at(-1)?.[2]).toEqual({ status: 'ongoing' });
      expect(calls.at(-1)?.[4]).toEqual({
        items: [{ id: 'saved-title', title: 'Saved title', source: 'source-a' }],
        hasMore: true,
      });
    });
  });

  it('does not restore removed-source results under a different source', async () => {
    readBrowseSnapshot.mockReturnValue({
      sourceId: 'removed-source',
      query: '',
      sortValue: '',
      filterValues: {},
      items: [{ id: 'old-title', title: 'Old title', source: 'removed-source' }],
      hasMore: true,
      scrollY: 300,
      savedAt: Date.now(),
    });

    render(page());

    await waitFor(() => {
      const calls = useSourceBrowsePaged.mock.calls;
      expect(calls.at(-1)?.[0]).toBe('source-a');
      expect(calls.at(-1)?.[4]).toBeNull();
    });
  });

  it('follows a changed source query parameter without remounting', async () => {
    getRequestedSource.mockReturnValue('source-a');
    const view = render(page());
    await waitFor(() => expect(useSourceBrowsePaged.mock.calls.at(-1)?.[0]).toBe('source-a'));

    getRequestedSource.mockReturnValue('source-b');
    view.rerender(page());

    await waitFor(() => expect(useSourceBrowsePaged.mock.calls.at(-1)?.[0]).toBe('source-b'));
  });

  it('submits source-wide search and clears back to browsing', async () => {
    render(page());
    const search = screen.getByRole('textbox', { name: 'Search all titles on this source' });
    fireEvent.change(search, { target: { value: '  target  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search', exact: true }));
    await waitFor(() => expect(useSourceBrowsePaged.mock.calls.at(-1)?.[5]).toBe('target'));

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    await waitFor(() => expect(useSourceBrowsePaged.mock.calls.at(-1)?.[5]).toBe(''));
  });

  it('restores a source-wide query when returning from a preview', async () => {
    readBrowseSnapshot.mockReturnValue({
      sourceId: 'source-a',
      category: 'popular',
      query: 'saved query',
      sortValue: '',
      filterValues: {},
      items: [{ id: 'saved-title', title: 'Saved title', source: 'source-a' }],
      hasMore: true,
      scrollY: 0,
      savedAt: Date.now(),
    });
    render(page());
    await waitFor(() => {
      expect(useSourceBrowsePaged.mock.calls.at(-1)?.[5]).toBe('saved query');
      expect(screen.getByRole('textbox', { name: 'Search all titles on this source' })).toHaveValue(
        'saved query',
      );
    });
  });
});
