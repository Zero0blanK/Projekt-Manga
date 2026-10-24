import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Manga } from '@/lib/manga-data';
import { MangaCoverDialog } from '@/components/manga-detail/cover-dialog';

vi.mock('@/components/manga-card', () => ({
  MangaCover: () => <div role="img" aria-label="Test cover" />,
}));

const manga = {
  id: 'm1',
  slug: 'test-manga',
  title: 'Test Manga',
  authors: [],
  artists: [],
  groups: null,
  source: 'fixture',
  chapters: 0,
  latestChapter: '',
  latestChapterNum: 0,
  updatedAt: '',
  status: 'Ongoing',
  tags: [],
  color: '',
  accent: '',
  synopsis: '',
  rating: null,
  thumbnailUrl: null,
  inLibrary: false,
} satisfies Manga;

describe('MangaCoverDialog accessibility', () => {
  it('names the dialog and restores focus to the cover trigger when dismissed', async () => {
    render(<MangaCoverDialog manga={manga} />);
    const trigger = screen.getByRole('button', { name: 'View cover for Test Manga' });

    fireEvent.click(trigger);
    expect(screen.getByRole('dialog', { name: 'Test Manga cover' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
