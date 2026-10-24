import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Manga } from '@/lib/manga-data';

vi.mock('@/components/downloads/row-data', () => ({ useDownloadRows: () => ({ completed: [] }) }));
vi.mock('@/lib/session-resource', () => ({
  useCurrentUser: () => ({ user: null, loading: false }),
}));
vi.mock('@/lib/profile-preferences', () => ({
  useProfilePreference: (_name: string, _parse: unknown, fallback: unknown) => [fallback, vi.fn()],
}));
vi.mock('@/components/library/library-tools', () => ({
  LibrarySelectionBar: () => null,
  parseDensity: () => 'comfortable',
}));

const { getHistory } = vi.hoisted(() => ({ getHistory: vi.fn() }));
const library: Manga[] = ['older', 'recent'].map((id) => ({
  // "recent" is fully read; "older" still has its one chapter unread.
  progress: id === 'recent' ? 1 : 0,
  id,
  slug: id,
  title: id,
  source: 'source-a',
  authors: null,
  artists: null,
  groups: null,
  chapters: 1,
  latestChapter: '',
  latestChapterNum: 1,
  updatedAt: '2026-01-01',
  status: 'Ongoing',
  tags: [],
  color: '',
  accent: '',
  synopsis: '',
  rating: null,
  thumbnailUrl: null,
  inLibrary: true,
}));

vi.mock('@projekt-manga/api-client', () => ({ getHistory }));
vi.mock('@/lib/library-store', () => ({
  useMangaLibrary: () => ({ manga: library, loading: false }),
  useLibraryState: () => ({ shelf: { older: 'reading', recent: 'reading' }, bookmarks: [] }),
}));
vi.mock('@/lib/app-store', () => ({
  useAppState: (selector: (state: object) => unknown) =>
    selector({
      sort: 'title',
      sortDir: 'asc',
      view: 'grid',
      categoryMembers: {},
    }),
}));
vi.mock('@/components/library/filter-pills', () => ({ FilterPills: () => null }));
vi.mock('@/components/library/view-toggle', () => ({ ViewToggle: () => null }));
vi.mock('@/components/library/sort-menu', () => ({ SortMenu: () => null }));
vi.mock('@/components/library/update-library-button', () => ({ UpdateLibraryButton: () => null }));
vi.mock('@/components/library/recently-updated-rail', () => ({ RecentlyUpdatedRail: () => null }));
vi.mock('@/components/library/library-grid', () => ({
  LibraryGrid: ({ manga }: { manga: Manga[] }) => (
    <ol data-testid="grid">
      {manga.map((m) => (
        <li key={m.id}>{m.title}</li>
      ))}
    </ol>
  ),
}));
vi.mock('@/components/library/continue-reading-hero', () => ({
  ContinueReadingHero: ({
    manga,
    recentRead,
  }: {
    manga: Manga;
    recentRead?: { chapter_id?: string; last_page_read?: number };
  }) => (
    <div data-testid="featured">
      {manga.title}|{recentRead?.chapter_id ?? ''}|{recentRead?.last_page_read ?? ''}
    </div>
  ),
}));

const { LibraryPageClient } = await import('@/app/client');

describe('Library featured title', () => {
  it('shows the most recently read library title after history arrives', async () => {
    getHistory.mockResolvedValue([
      { manga_id: 'older', last_read: '2026-01-01T00:00:00Z', read_at: '2026-01-01T00:00:00Z' },
      { manga_id: 'recent', last_read: '2026-02-01T00:00:00Z', read_at: '2026-02-01T00:00:00Z' },
    ]);
    render(<LibraryPageClient />);
    await waitFor(() => expect(screen.getByTestId('featured')).toHaveTextContent('recent'));
  });

  // The hero builds its Resume link from the history entry it is given; this checks the page
  // hands it the most recent entry, so it resumes the recorded release and page rather than
  // the published latest chapter.
  it('resumes recent titles at their recorded release and page instead of the published latest', async () => {
    getHistory.mockResolvedValueOnce([
      {
        manga_id: 'recent',
        source: 'source-a',
        manga_slug: 'recent',
        chapter_id: 'release/one',
        chapter_number: 0.5,
        last_page_read: 7,
        last_read: '2026-02-01T00:00:00Z',
        read_at: '2026-02-01T00:00:00Z',
      },
      {
        manga_id: 'older',
        source: 'source-a',
        manga_slug: 'older',
        chapter_id: 'release-two',
        chapter_number: 2,
        last_page_read: 0,
        last_read: '2026-01-01T00:00:00Z',
        read_at: '2026-01-01T00:00:00Z',
      },
    ]);
    render(<LibraryPageClient />);
    await waitFor(() =>
      expect(screen.getByTestId('featured')).toHaveTextContent('recent|release/one|7'),
    );
  });

  it('narrows the grid to titles with unread chapters', async () => {
    getHistory.mockResolvedValue([]);
    render(<LibraryPageClient />);
    const grid = await screen.findByTestId('grid');
    expect(grid).toHaveTextContent('older');
    expect(grid).toHaveTextContent('recent');
    fireEvent.click(screen.getByRole('button', { name: 'Unread' }));
    expect(screen.getByTestId('grid')).toHaveTextContent('older');
    expect(screen.getByTestId('grid')).not.toHaveTextContent('recent');
    expect(screen.getByRole('button', { name: 'Unread' })).toHaveAttribute('aria-pressed', 'true');
  });
});
