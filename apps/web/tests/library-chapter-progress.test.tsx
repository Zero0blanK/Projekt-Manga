import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Manga } from '@/lib/manga-data';
vi.mock('@/lib/session-resource', () => ({
  useCurrentUser: () => ({ user: null, loading: false }),
}));

const { getMangaChapters, getAllDownloads } = vi.hoisted(() => ({
  getMangaChapters: vi.fn(),
  getAllDownloads: vi.fn(),
}));

vi.mock('@projekt-manga/api-client', () => ({ getMangaChapters, getAllDownloads }));
vi.mock('@/lib/manga-updates', () => ({
  useChapterListVersion: () => 0,
  useMangaUpdateCheck: () => ({ checking: false }),
  useCheckOnManualReload: () => undefined,
}));

const { ChapterList } = await import('@/components/manga-detail/chapter-list');

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

describe('library chapter progress', () => {
  it('shows a saved page even when an old placeholder has no page count', async () => {
    getMangaChapters.mockResolvedValueOnce([
      {
        id: 'chapter-3',
        chapter_number: 3,
        name: 'The middle',
        is_read: false,
        last_page_read: 7,
        page_count: null,
        release_date: null,
        fetched_at: null,
        created_at: '2026-01-01T00:00:00Z',
        scanlator: null,
      },
    ]);
    getAllDownloads.mockResolvedValueOnce([]);

    render(<ChapterList manga={manga} />);

    expect(await screen.findByText('Page 7')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /The middle/ })).toHaveAttribute(
      'href',
      '/reader/manga-1?ch=3&page=7&chapterId=chapter-3',
    );
  });
});
