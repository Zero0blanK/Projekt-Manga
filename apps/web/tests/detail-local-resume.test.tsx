import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Manga } from '@/lib/manga-data';
vi.mock('@/components/manga-detail/source-switch', () => ({ SourceSwitch: () => null }));

const { getMangaDetailsById, getAllDownloads } = vi.hoisted(() => ({
  getMangaDetailsById: vi.fn(),
  getAllDownloads: vi.fn(),
}));

vi.mock('@projekt-manga/api-client', () => ({
  getMangaDetailsById,
  getAllDownloads,
  hasLocalDataBridge: () => true,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/lib/library-store', () => ({
  useLibraryState: () => ({ bookmarks: [], shelf: {} }),
}));
vi.mock('@/components/manga-detail/tracker-link-button', () => ({
  TrackerLinkButton: () => null,
}));

const { MangaActionBar } = await import('@/components/manga-detail/action-bar');

const manga: Manga = {
  id: 'manga-1',
  slug: 'manga-1',
  title: 'A title',
  source: 'source-a',
  authors: null,
  artists: null,
  groups: null,
  chapters: 1,
  latestChapter: 'Chapter 3',
  latestChapterNum: 3,
  updatedAt: '2026-01-01',
  status: 'Ongoing',
  tags: [],
  color: '',
  accent: '',
  synopsis: '',
  rating: null,
  thumbnailUrl: null,
  inLibrary: true,
};

describe('manga detail desktop resume', () => {
  it('uses the local saved page when the server-rendered manga has no progress', async () => {
    getAllDownloads.mockResolvedValue([]);
    getMangaDetailsById.mockResolvedValue({
      id: 'manga-1',
      slug: 'manga-1',
      title: 'A title',
      source: 'source-a',
      author: 'Author',
      artist: null,
      description: '',
      genres: '',
      status: 'ONGOING',
      rating: null,
      thumbnail_url: '',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      in_library: true,
      chapters: [
        {
          id: 'chapter-3',
          chapter_number: 3,
          is_read: false,
          last_page_read: 7,
          page_count: 10,
          name: 'The middle',
        },
      ],
    });

    render(<MangaActionBar manga={manga} knownChapters={[]} />);

    expect(await screen.findByRole('link', { name: 'Continue Ch. 3' })).toHaveAttribute(
      'href',
      '/reader/manga-1?ch=3&page=7',
    );
  });
});
