import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MangaChapterRecord } from '@projekt-manga/api-client';
import { ChapterListPanel } from '@/components/reader/chapter-list-panel';

vi.mock('next/link', () => ({
  default: ({
    href,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props} />
  ),
}));

function chapters(count: number): MangaChapterRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `chapter-${index + 1}`,
    manga_id: 'manga-1',
    url: `/chapter/${index + 1}`,
    name: `Chapter ${index + 1}`,
    scanlator: null,
    is_read: false,
    is_bookmark: false,
    chapter_number: index + 1,
    last_page_read: 0,
    page_count: null,
    fetched_at: null,
    release_date: null,
    created_at: '',
    updated_at: '',
  }));
}

function chapterLink(container: ParentNode, number: number) {
  return (
    [...container.querySelectorAll<HTMLAnchorElement>('a')].find(
      (link) =>
        link.getAttribute('href') === `/reader/manga-1?ch=${number}&chapterId=chapter-${number}`,
    ) ?? null
  );
}

describe('ChapterListPanel', () => {
  it('mounts a bounded accessible window for long series', () => {
    const entries = chapters(50_000);
    render(
      <ChapterListPanel
        mangaId="manga-1"
        chapters={entries}
        activeChapter={1}
        onClose={() => undefined}
      />,
    );

    expect(screen.getByRole('list', { name: 'Chapters' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(26);
    expect(screen.getAllByRole('listitem')[25]).toHaveAttribute('aria-posinset', '50000');
    expect(chapterLink(document, 50000)).toBeNull();
  });

  it('moves keyboard focus to the first and last chapter across the virtual window', async () => {
    const { container } = render(
      <ChapterListPanel
        mangaId="manga-1"
        chapters={chapters(50_000)}
        activeChapter={1}
        onClose={() => undefined}
      />,
    );

    const oldest = chapterLink(container, 1);
    expect(oldest).not.toBeNull();
    if (!oldest) throw new Error('The oldest chapter should be mounted initially');
    oldest.focus();
    fireEvent.keyDown(oldest, { key: 'Home' });
    const newest = await waitFor(() => {
      const link = chapterLink(container, 50000);
      if (!link) throw new Error('Home should mount the newest chapter');
      return link;
    });
    await waitFor(() => expect(newest).toHaveFocus());

    fireEvent.keyDown(newest, { key: 'End' });
    await waitFor(() => {
      const last = chapterLink(container, 1);
      expect(last).toHaveFocus();
    });
  });
});
