import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const getHistory = vi.fn();
vi.mock('@projekt-manga/api-client', () => ({
  getHistory,
  buildImageProxyUrl: (url: string) => url,
}));
vi.mock('@/lib/library-store', () => ({
  useMangaLibrary: () => ({ manga: [], loading: false }),
}));

const { RecentsPageClient } = await import('@/app/recents/client');

describe('Recents resume', () => {
  it('shows a source-only title and cover and resumes by chapter id', async () => {
    getHistory.mockResolvedValueOnce([
      {
        id: 'history-1',
        source: 'source-a',
        manga_slug: 'source-title',
        chapter_id: 'chapter-7',
        chapter_number: 0,
        title: 'Real Title',
        thumbnail_url: 'https://example.com/cover.jpg',
        last_read: '2026-09-27T00:00:00Z',
        read_at: '2026-09-27T00:00:00Z',
        last_page_read: 3,
        page_count: 10,
      },
    ]);

    render(<RecentsPageClient />);

    expect(await screen.findByRole('link', { name: 'Real Title' })).toHaveAttribute(
      'href',
      '/discover/preview/source-a/source-title',
    );
    expect(screen.getByRole('link', { name: 'Resume' })).toHaveAttribute(
      'href',
      '/discover/preview/source-a/source-title/read?chapterId=chapter-7&page=3',
    );
    expect(screen.getByRole('img', { name: 'Real Title' })).toHaveAttribute(
      'src',
      'https://example.com/cover.jpg',
    );
  });
});
