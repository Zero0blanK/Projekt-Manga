import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Mangas } from '@projekt-manga/types';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

const addSourceMangaToLibrary = vi.fn();
vi.mock('@/lib/discover-actions', () => ({
  addSourceMangaToLibrary: (...a: unknown[]) => addSourceMangaToLibrary(...a),
}));

const migrateManga = vi.fn();
vi.mock('@/lib/migrate-manga', () => ({
  migrateManga: (...a: unknown[]) => migrateManga(...a),
  describeMigration: () => 'migrated',
}));

const refresh = vi.fn();
let libraryRows: unknown[] = [];
vi.mock('@/lib/library-store', () => ({
  useMangaLibrary: () => ({ manga: libraryRows, refresh }),
}));

const toast = vi.fn();
vi.mock('@/hooks/use-toast', () => ({ toast: (...a: unknown[]) => toast(...a) }));

const { useDuplicateCheckedAdd } = await import('@/components/discover/duplicate-manga-dialog');

const existing = {
  id: 'lib-1',
  title: 'Rent-A-Girlfriend',
  slug: 'rent-a-gf',
  source: 'mangadex',
  thumbnailUrl: null,
  inLibrary: true,
};

const incoming = {
  id: 'kg-1',
  title: 'Rent a Girlfriend',
  slug: 'rent-a-girlfriend',
  source: 'kissmanga',
} as unknown as Mangas;

/** Minimal host: one button that runs the guarded add, plus the dialog it may open. */
function Harness() {
  const { requestAdd, dialog } = useDuplicateCheckedAdd();
  return (
    <>
      <button onClick={() => void requestAdd('kissmanga', incoming)}>Add</button>
      {dialog}
    </>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  libraryRows = [existing];
  addSourceMangaToLibrary.mockResolvedValue('new-1');
  migrateManga.mockResolvedValue({ problems: [] });
});

describe('duplicate warning dialog', () => {
  it('adds straight away when nothing in the library looks similar', async () => {
    libraryRows = [];
    render(<Harness />);

    await userEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(addSourceMangaToLibrary).toHaveBeenCalled());
    expect(screen.queryByText('Already in your library?')).not.toBeInTheDocument();
  });

  it('asks first when a similar title is already in the library', async () => {
    render(<Harness />);

    await userEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(await screen.findByText('Already in your library?')).toBeInTheDocument();
    expect(screen.getByText('Rent-A-Girlfriend')).toBeInTheDocument();
    // Nothing has been written yet — the whole point is that it asks before adding.
    expect(addSourceMangaToLibrary).not.toHaveBeenCalled();
  });

  it('restores focus to the add control when the warning dialog closes', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const add = screen.getByRole('button', { name: 'Add' });

    await user.click(add);
    expect(await screen.findByRole('dialog', { name: 'Already in your library?' })).toBeVisible();
    await user.keyboard('{Escape}');

    await waitFor(() => expect(add).toHaveFocus());
  });

  it('offers Show entry and Migrate for the matched title', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    await screen.findByText('Already in your library?');

    expect(screen.getByRole('button', { name: 'Show entry' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Migrate' })).toBeInTheDocument();
  });

  it('navigates to the existing entry on Show entry, without adding anything', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    await screen.findByText('Already in your library?');

    await userEvent.click(screen.getByRole('button', { name: 'Show entry' }));

    expect(push).toHaveBeenCalledWith('/manga/lib-1');
    expect(addSourceMangaToLibrary).not.toHaveBeenCalled();
  });

  it('adds the new title anyway when asked to', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    await screen.findByText('Already in your library?');

    await userEvent.click(screen.getByRole('button', { name: 'Add anyway' }));

    await waitFor(() =>
      expect(addSourceMangaToLibrary).toHaveBeenCalledWith('kissmanga', incoming, undefined),
    );
    expect(migrateManga).not.toHaveBeenCalled();
  });

  it('creates the new entry first, then migrates the old one into it', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    await screen.findByText('Already in your library?');

    await userEvent.click(screen.getByRole('button', { name: 'Migrate' }));

    // Migration is keyed on the new row's manga_id, so the add has to happen first.
    await waitFor(() => expect(migrateManga).toHaveBeenCalled());
    expect(addSourceMangaToLibrary).toHaveBeenCalled();
    expect(migrateManga.mock.calls[0][0]).toMatchObject({
      from: { mangaId: 'lib-1', slug: 'rent-a-gf' },
      to: { mangaId: 'new-1', slug: 'rent-a-girlfriend' },
      removeOld: true,
    });
  });

  it('closes without doing anything on Cancel', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    await screen.findByText('Already in your library?');

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() =>
      expect(screen.queryByText('Already in your library?')).not.toBeInTheDocument(),
    );
    expect(addSourceMangaToLibrary).not.toHaveBeenCalled();
    expect(migrateManga).not.toHaveBeenCalled();
  });
});
