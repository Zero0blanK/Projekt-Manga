import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Manga } from '@/lib/manga-data';
import { MangaCoverDialog } from '@/components/manga-detail/cover-dialog';

const { refresh, api, toast } = vi.hoisted(() => ({
  refresh: vi.fn(),
  api: {
    uploadMangaCover: vi.fn(async () => null),
    removeMangaCover: vi.fn(async () => null),
  },
  toast: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
vi.mock('@projekt-manga/api-client', () => api);
vi.mock('@/hooks/use-toast', () => ({ toast }));
vi.mock('@/lib/query-client', () => ({
  queryClient: { invalidateQueries: vi.fn() },
  queryKeys: { mangaLibrary: ['manga-library'] },
}));
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

const inLibrary = (hasCover = false): Manga => ({
  ...manga,
  inLibrary: true,
  thumbnailUrl: 'http://api.test/api/cache/thumbnail/m1',
  editable: {
    title: 'Test Manga',
    author: '',
    description: '',
    status: 'ONGOING',
    override: hasCover ? ({ has_cover: true } as NonNullable<Manga['editable']>['override']) : null,
  },
});

const open = (value: Manga) => {
  render(<MangaCoverDialog manga={value} />);
  fireEvent.click(screen.getByRole('button', { name: 'View cover for Test Manga' }));
  return screen.getByRole('dialog', { name: 'Test Manga cover' });
};

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

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

describe('MangaCoverDialog', () => {
  it('keeps its one close button outside the picture', async () => {
    const dialog = open(inLibrary());
    const closes = within(dialog).getAllByRole('button', { name: /close/i });
    expect(closes).toHaveLength(1);
    expect(screen.getByTestId('cover-viewer-image')).not.toContainElement(closes[0]);

    fireEvent.click(closes[0]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('saves the cover under the title’s name', async () => {
    const image = new Blob(['png'], { type: 'image/png' });
    const fetch = vi.fn(async () => ({ ok: true, blob: async () => image }));
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:cover', revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      expect(this.download).toBe('Test Manga cover.png');
      expect(this.href).toBe('blob:cover');
    });

    const dialog = open(inLibrary());
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save image' }));

    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledWith('http://api.test/api/cache/thumbnail/m1', {
      credentials: 'include',
    });
    click.mockRestore();
  });

  it('cannot save a title that has no cover', () => {
    const dialog = open(manga);
    expect(within(dialog).getByRole('button', { name: 'Save image' })).toBeDisabled();
  });

  it('changes the cover of a library title', async () => {
    const dialog = open(inLibrary());
    const file = new File(['img'], 'new.png', { type: 'image/png' });
    fireEvent.change(within(dialog).getByLabelText('Choose a new cover image'), {
      target: { files: [file] },
    });

    await waitFor(() => expect(api.uploadMangaCover).toHaveBeenCalledWith('m1', file));
    expect(refresh).toHaveBeenCalled();
  });

  it('refuses a file that is not a supported image', () => {
    const dialog = open(inLibrary());
    fireEvent.change(within(dialog).getByLabelText('Choose a new cover image'), {
      target: { files: [new File(['%PDF'], 'doc.pdf', { type: 'application/pdf' })] },
    });

    expect(api.uploadMangaCover).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith({
      description: 'Choose a JPEG, PNG, GIF, WebP or AVIF image.',
    });
  });

  it('offers the source cover back only once a custom one is set', async () => {
    expect(
      within(open(inLibrary())).queryByRole('button', { name: 'Use source cover' }),
    ).toBeNull();
    cleanup();

    const dialog = open(inLibrary(true));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Use source cover' }));
    await waitFor(() => expect(api.removeMangaCover).toHaveBeenCalledWith('m1'));
  });

  it('offers no cover change for a title outside the library', () => {
    const dialog = open(manga);
    expect(within(dialog).queryByRole('button', { name: /change cover/i })).toBeNull();
  });
});
