import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ApiError } from '@projekt-manga/api-client';

const store = vi.hoisted(() => ({
  library: { manga: [] as unknown[], loading: false, error: null as unknown, refresh: vi.fn() },
  state: { bookmarks: [] as string[], loading: false, error: null as unknown, refresh: vi.fn() },
}));
vi.mock('@/lib/library-store', () => ({
  useMangaLibrary: () => store.library,
  useLibraryState: () => store.state,
}));
vi.mock('@/components/manga-card', () => ({ MangaCard: () => null }));

const { BookmarksPageClient } = await import('@/app/bookmarks/client');

afterEach(() => {
  cleanup();
  store.library.error = null;
  store.state.error = null;
  vi.clearAllMocks();
});

describe('bookmarks when loading fails', () => {
  it('says the bookmarks did not load, instead of "nothing bookmarked"', () => {
    store.library.error = new ApiError('Unable to reach the server.', 0, 'network');
    render(<BookmarksPageClient />);

    expect(screen.getByRole('alert')).toHaveTextContent("Your bookmarks didn't load.");
    expect(screen.queryByText(/Nothing bookmarked yet/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(store.library.refresh).toHaveBeenCalledTimes(1);
    expect(store.state.refresh).not.toHaveBeenCalled();
  });

  it('still shows the empty state when everything loaded and nothing is bookmarked', () => {
    render(<BookmarksPageClient />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText(/Nothing bookmarked yet/)).toBeInTheDocument();
  });
});
