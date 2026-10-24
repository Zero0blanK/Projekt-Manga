import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { HistoryEntry } from '@projekt-manga/api-client';
import type { Manga } from '@/lib/manga-data';

const { bookmarks } = vi.hoisted(() => ({ bookmarks: [] as string[] }));

vi.mock('@/lib/library-store', () => ({ useLibraryState: () => ({ bookmarks }) }));
vi.mock('@/components/manga-card', () => ({ MangaCover: () => null }));

const { ContinueReadingHero } = await import('@/components/library/continue-reading-hero');

const manga: Manga = {
  id: 'manga-1',
  slug: 'manga-1',
  title: 'A title',
  source: 'source-a',
  authors: null,
  artists: null,
  groups: null,
  chapters: 5,
  latestChapter: 'Chapter 5',
  latestChapterNum: 5,
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

const recentRead: HistoryEntry = {
  id: 'read-1',
  source: 'source-a',
  manga_id: 'manga-1',
  manga_slug: 'manga-1',
  chapter_id: 'chapter-3',
  chapter_number: 3,
  name: 'The middle',
  pages_read: 7,
  time_read: 0,
  last_read: '2026-02-01T00:00:00Z',
  read_at: '2026-02-01T00:00:00Z',
  last_page_read: 7,
  page_count: 10,
};

describe('library featured reading progress', () => {
  beforeEach(() => bookmarks.splice(0, bookmarks.length));

  it('exposes the bookmark toggle state and action to assistive technology', () => {
    const { unmount } = render(<ContinueReadingHero manga={manga} recentRead={recentRead} />);
    expect(screen.getByRole('button', { name: 'Bookmark' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    unmount();

    bookmarks.push(manga.id);
    render(<ContinueReadingHero manga={manga} recentRead={recentRead} />);
    expect(screen.getByRole('button', { name: 'Remove bookmark' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('shows page progress and resumes the actual chapter instead of defaulting to chapter one', () => {
    render(<ContinueReadingHero manga={manga} recentRead={recentRead} />);
    expect(screen.getByText('70%')).toBeInTheDocument();
    expect(screen.getByText('Chapter 3 · The middle')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Resume/ })).toHaveAttribute(
      'href',
      '/reader/manga-1?ch=3&chapterId=chapter-3&page=7',
    );
  });

  it('keeps the library-level fallback when no recent chapter is available', () => {
    render(<ContinueReadingHero manga={{ ...manga, progress: 0.4, currentChapter: 2 }} />);
    expect(screen.getByText('40%')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Resume/ })).toHaveAttribute(
      'href',
      '/reader/manga-1?ch=2',
    );
  });

  it('shows the saved page instead of a misleading 0% when the chapter total is unknown', () => {
    render(<ContinueReadingHero manga={manga} recentRead={{ ...recentRead, page_count: 0 }} />);
    expect(screen.getByText('Page 7')).toBeInTheDocument();
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
  });
});
