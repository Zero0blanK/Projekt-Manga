import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Manga } from '@/lib/manga-data';
import { coverCorner } from '@/lib/cover-badges';

const settings = vi.hoisted(() => ({ values: {} as Record<string, unknown> }));
vi.mock('@/lib/app-store', () => ({
  useSetting: (key: string, fallback: unknown) =>
    key in settings.values ? settings.values[key] : fallback,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/components/cover', () => ({ Cover: () => null }));

const { MangaCard } = await import('@/components/manga-card');

const manga = {
  id: 'm1',
  slug: 'test-manga',
  title: 'Test Manga',
  authors: [],
  artists: [],
  groups: null,
  source: 'fixture',
  chapters: 10,
  latestChapter: '10',
  latestChapterNum: 10,
  updatedAt: '',
  status: 'Ongoing',
  tags: [],
  color: '',
  accent: '',
  synopsis: '',
  rating: null,
  thumbnailUrl: null,
  inLibrary: true,
  progress: 0.4,
} satisfies Manga;

afterEach(() => {
  cleanup();
  settings.values = {};
});

describe('cover badges', () => {
  it('joins the counts in the top left, numbers only, with the download count off by default', () => {
    render(<MangaCard manga={manga} downloaded downloadCount={3} />);
    const badges = screen.getByRole('img', { name: '6 unread chapters, latest chapter 10' });
    expect(badges.textContent).toBe('6Ch. 10');
    // Not counting downloads, so the offline icon still says the title has some.
    expect(screen.getByRole('img', { name: 'Has downloaded chapters' })).toBeTruthy();
  });

  it('adds the download count when turned on, in place of the offline icon', () => {
    settings.values = { showDownloadBadge: true };
    render(<MangaCard manga={manga} downloaded downloadCount={3} />);
    const badges = screen.getByRole('img', {
      name: '6 unread chapters, 3 downloaded chapters, latest chapter 10',
    });
    expect(badges.textContent).toBe('36Ch. 10');
    expect(screen.queryByRole('img', { name: 'Has downloaded chapters' })).toBeNull();
  });

  it('shows labelled pills when chosen', () => {
    settings.values = { coverBadgeStyle: 'pills' };
    render(<MangaCard manga={manga} />);
    expect(screen.getByText('6 unread')).toBeTruthy();
  });

  it('puts the counts under the title instead of on the cover', () => {
    settings.values = { coverBadgePosition: 'below-title', showChapterBadge: false };
    render(<MangaCard manga={manga} />);
    const line = screen.getByLabelText('6 unread chapters');
    expect(line.tagName).toBe('P');
    expect(line.textContent).toBe('6 unread');
  });

  it('moves a bottom corner to the top where the title covers the bottom', () => {
    expect(coverCorner('bottom-left', { titleOnCover: true })).toBe('top-left');
    expect(coverCorner('bottom-right', { titleOnCover: true })).toBe('top-right');
    expect(coverCorner('bottom-right')).toBe('bottom-right');
    expect(coverCorner('below-title')).toBe('top-left');
  });
});
