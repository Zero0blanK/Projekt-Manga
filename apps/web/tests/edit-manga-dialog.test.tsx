import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

const { refresh, api } = vi.hoisted(() => ({
  refresh: vi.fn(),
  api: {
    updateMangaOverride: vi.fn(async () => null),
    resetMangaOverride: vi.fn(async () => null),
    uploadMangaCover: vi.fn(async () => null),
    removeMangaCover: vi.fn(async () => null),
  },
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
vi.mock('@projekt-manga/api-client', () => api);
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));
vi.mock('@/lib/query-client', () => ({
  queryClient: { invalidateQueries: vi.fn() },
  queryKeys: { mangaLibrary: ['manga-library'] },
}));

import { EditMangaDialog } from '@/components/manga-detail/edit-manga-dialog';
import type { Manga } from '@/lib/manga-data';

const manga = (override: NonNullable<Manga['editable']>['override'] = null): Manga => ({
  id: 'manga-1',
  slug: 'slug',
  title: override?.title ?? 'Source Title',
  authors: ['Source Author'],
  artists: null,
  groups: null,
  source: 'test-source',
  chapters: 0,
  latestChapter: 'No chapters yet',
  latestChapterNum: 0,
  updatedAt: '2026-10-28T00:00:00.000Z',
  status: 'Ongoing',
  tags: [],
  color: 'gray',
  accent: 'gray',
  synopsis: 'Source description',
  rating: null,
  thumbnailUrl: null,
  inLibrary: true,
  editable: {
    title: override?.title ?? 'Source Title',
    author: 'Source Author',
    description: 'Source description',
    status: 'ONGOING',
    override,
  },
});

beforeEach(() => vi.clearAllMocks());

it('sends only the fields that changed', async () => {
  render(<EditMangaDialog manga={manga()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit details' }));

  fireEvent.change(screen.getByLabelText('Title'), { target: { value: '  My Title  ' } });
  fireEvent.keyDown(screen.getByLabelText('Status'), { key: 'Enter' });
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Completed' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(refresh).toHaveBeenCalled());
  expect(api.updateMangaOverride).toHaveBeenCalledWith('manga-1', {
    title: 'My Title',
    status: 'COMPLETED',
  });
  expect(api.uploadMangaCover).not.toHaveBeenCalled();
  // Nothing to reset on an unedited title.
  expect(screen.queryByRole('button', { name: 'Reset to source' })).toBeNull();
});

it('clears an edited field set back to the source value, and offers a reset', async () => {
  render(
    <EditMangaDialog
      manga={manga({
        title: 'My Title',
        author: null,
        description: null,
        status: null,
        has_cover: false,
        updated_at: '2026-10-28T00:00:00.000Z',
        original: {
          title: 'Source Title',
          author: 'Source Author',
          description: 'Source description',
          status: 'ONGOING',
        },
      })}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Edit details' }));
  expect(screen.getByText('Source: Source Title')).toBeTruthy();

  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Source Title' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(api.updateMangaOverride).toHaveBeenCalledWith('manga-1', { title: null }),
  );

  fireEvent.click(screen.getByRole('button', { name: 'Edit details' }));
  fireEvent.click(screen.getByRole('button', { name: 'Reset to source' }));
  await waitFor(() => expect(api.resetMangaOverride).toHaveBeenCalledWith('manga-1'));
});

it('uploads a chosen cover and refuses one that is too large', async () => {
  render(<EditMangaDialog manga={manga()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit details' }));
  const input = screen.getByLabelText('Choose a cover image');
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();

  const huge = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' });
  fireEvent.change(input, { target: { files: [huge] } });
  expect(screen.queryByAltText('Cover preview')).toBeNull();

  const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'c.png', { type: 'image/png' });
  fireEvent.change(input, { target: { files: [file] } });
  expect(screen.getByAltText('Cover preview').getAttribute('src')).toBe('blob:preview');
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(api.uploadMangaCover).toHaveBeenCalledWith('manga-1', file));
  expect(api.updateMangaOverride).not.toHaveBeenCalled();
});

it('is hidden where there is nothing to edit', () => {
  const { container } = render(<EditMangaDialog manga={{ ...manga(), editable: undefined }} />);
  expect(container.innerHTML).toBe('');
});
