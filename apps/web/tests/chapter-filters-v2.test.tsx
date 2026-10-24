import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Manga } from '@/lib/manga-data';
const fixture = vi.hoisted(() => ({ chapters: vi.fn(), downloads: vi.fn() }));
vi.mock('@projekt-manga/api-client', () => ({
  getMangaChapters: fixture.chapters,
  getAllDownloads: fixture.downloads,
}));
vi.mock('@/lib/session-resource', () => ({
  useCurrentUser: () => ({ user: null, loading: false }),
}));
vi.mock('@/lib/manga-updates', () => ({
  useChapterListVersion: () => 0,
  useMangaUpdateCheck: () => ({ checking: false }),
  useCheckOnManualReload: () => undefined,
}));
vi.mock('@/lib/chapter-bookmarks', () => ({
  useChapterBookmarks: () => ({ isBookmarked: (id: string) => id === 'c2', toggle: vi.fn() }),
}));
vi.mock('@/components/downloads/chapter-download-picker', () => ({
  ChapterDownloadPicker: ({ selectedIds }: { selectedIds: string[] }) => (
    <div data-testid="download-selection">{selectedIds.join(',')}</div>
  ),
}));
const { ChapterList } = await import('@/components/manga-detail/chapter-list');
const manga = {
  id: 'manga',
  slug: 'slug',
  source: 'source',
  title: 'Title',
  inLibrary: true,
} as Manga;
const records = Array.from({ length: 205 }, (_, i) => ({
  id: `c${i}`,
  chapter_number: i,
  name: `Episode ${i}`,
  is_read: i === 204,
  last_page_read: 0,
  page_count: 10,
  release_date: null,
  fetched_at: null,
  created_at: '2026-01-01',
  scanlator: 'Group',
}));
describe('v2 chapter filters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fixture.chapters.mockResolvedValue(records);
    fixture.downloads.mockResolvedValue([
      { chapter_id: 'c1', status: 'COMPLETED' },
      { chapter_id: 'c2', status: 'PENDING' },
    ]);
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  });
  it('clears an empty search with the existing search control and has no reset filters action', async () => {
    render(<ChapterList manga={manga} />);
    await screen.findAllByRole('link');
    fireEvent.change(screen.getByLabelText('Find a chapter'), { target: { value: 'unfindable' } });
    expect(screen.getByText('No chapters match your filters.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Reset chapter filters' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(screen.getAllByRole('link').length).toBeGreaterThan(1);
  });
  it('uses completed downloads for offline filters and keeps bookmarked chapters discoverable', async () => {
    render(<ChapterList manga={manga} />);
    await screen.findAllByRole('link');
    await waitFor(() => expect(fixture.downloads).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Downloaded', exact: true }));
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.getByRole('link')).toHaveTextContent('Episode 1');
    fireEvent.click(screen.getByRole('button', { name: 'Bookmarked', exact: true }));
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.getByRole('link')).toHaveTextContent('Episode 2');
  });
  it('bounds mounted rows without chapter pagination buttons', async () => {
    render(<ChapterList manga={manga} />);
    await screen.findAllByRole('link');
    expect(screen.getAllByRole('link').length).toBeLessThan(205);
    expect(screen.queryByRole('button', { name: 'Next chapter page' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Downloaded', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: 'All', exact: true }));
    expect(screen.getAllByRole('link').length).toBeGreaterThan(1);
    expect(screen.getAllByRole('link').length).toBeLessThan(205);
  });
});
