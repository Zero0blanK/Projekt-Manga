import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { DownloadRestoreScan, RestorableTitle } from '@projekt-manga/api-client';

const mocks = vi.hoisted(() => ({
  scan: vi.fn(),
  restore: vi.fn(),
  setDirectory: vi.fn(),
  setTitleInLibrary: vi.fn(),
  refreshLibrary: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('@projekt-manga/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@projekt-manga/api-client')>()),
  scanForDownloadsToRestore: mocks.scan,
  restoreDownloads: mocks.restore,
  setDownloadDirectory: mocks.setDirectory,
}));
vi.mock('@/lib/library-store', () => ({
  setTitleInLibrary: mocks.setTitleInLibrary,
  refreshLibrary: mocks.refreshLibrary,
}));
vi.mock('@/hooks/use-toast', () => ({ toast: mocks.toast }));

const { RestoreDownloads } = await import('@/components/downloads/restore-downloads');

function title(over: Partial<RestorableTitle> & { id: string; title: string }): RestorableTitle {
  return {
    source: 'src',
    sourceName: 'Source',
    thumbnailUrl: null,
    folder: `D:\\Downloads\\${over.title}`,
    status: 'ready',
    chapters: { ready: 2, incomplete: 0, alreadyInApp: 0, unmatched: 0 },
    sizeBytes: 3 * 1024 * 1024,
    ...over,
  };
}

const found: DownloadRestoreScan = {
  roots: ['D:\\Downloads'],
  restorableChapters: 5,
  titles: [
    title({ id: 'a'.repeat(64), title: 'First' }),
    title({
      id: 'b'.repeat(64),
      title: 'Second',
      chapters: { ready: 3, incomplete: 1, alreadyInApp: 0, unmatched: 0 },
    }),
    title({
      id: 'c'.repeat(64),
      title: 'Waiting',
      status: 'needs-source',
      source: 'gone',
      sourceName: null,
      chapters: { ready: 0, incomplete: 0, alreadyInApp: 0, unmatched: 4 },
    }),
  ],
};
const empty: DownloadRestoreScan = { roots: ['D:\\Downloads'], restorableChapters: 0, titles: [] };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.restore.mockResolvedValue({
    restored: 5,
    relinked: 0,
    titles: [
      { id: 'a'.repeat(64), mangaId: 'manga-a', title: 'First' },
      { id: 'b'.repeat(64), mangaId: 'manga-b', title: 'Second' },
    ],
  });
});

afterEach(() => {
  delete (window as unknown as { desktop?: unknown }).desktop;
});

describe('restoring downloads from an earlier install', () => {
  it('says nothing when there is nothing to restore', async () => {
    mocks.scan.mockResolvedValue(empty);
    render(<RestoreDownloads onRestored={vi.fn()} />);
    await waitFor(() => expect(mocks.scan).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Review and restore' })).toBeNull();
    expect(
      screen.getByRole('button', { name: /Find downloads in another folder/ }),
    ).toBeInTheDocument();
  });

  it('offers what it found, and adds only the ticked titles to the library', async () => {
    mocks.scan.mockResolvedValueOnce(found).mockResolvedValue(empty);
    const onRestored = vi.fn();
    render(<RestoreDownloads onRestored={onRestored} />);

    expect(
      await screen.findByText('Found 2 downloaded titles (5 chapters) to restore'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Review and restore' }));

    const list = await screen.findByRole('list', { name: 'Titles found' });
    expect(
      within(list).getByText('Install the gone source to restore this title.'),
    ).toBeInTheDocument();
    expect(within(list).getByText('1 incomplete chapter skipped')).toBeInTheDocument();
    // The title that can't be restored has no library choice.
    expect(screen.queryByRole('checkbox', { name: 'Add Waiting to library' })).toBeNull();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Add Second to library' }));
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Restore 5 chapters' })),
    );

    expect(mocks.restore).toHaveBeenCalledWith(['a'.repeat(64), 'b'.repeat(64)], undefined);
    expect(mocks.setTitleInLibrary).toHaveBeenCalledTimes(1);
    expect(mocks.setTitleInLibrary).toHaveBeenCalledWith('manga-b', true, { refresh: false });
    expect(mocks.refreshLibrary).toHaveBeenCalledTimes(1);
    expect(onRestored).toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith({
      description: 'Restored 5 chapters from 2 titles.',
    });
  });

  it('adds every title to the library in one go', async () => {
    mocks.scan.mockResolvedValueOnce(found).mockResolvedValue(empty);
    render(<RestoreDownloads onRestored={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Review and restore' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Add all to library' }));
    expect(screen.getByRole('checkbox', { name: 'Add First to library' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Add Second to library' })).toBeChecked();
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Restore 5 chapters' })),
    );

    expect(mocks.setTitleInLibrary.mock.calls.map((call) => call[0])).toEqual([
      'manga-a',
      'manga-b',
    ]);
  });

  it('looks in a folder picked on the desktop, and can make it the download folder', async () => {
    mocks.scan.mockImplementation(async (root?: string) => (root ? found : empty));
    const pickFolder = vi.fn(async () => ({ success: true, data: 'E:\\Old manga' }));
    (window as unknown as { desktop: unknown }).desktop = { pickFolder };
    render(<RestoreDownloads onRestored={vi.fn()} />);
    await waitFor(() => expect(mocks.scan).toHaveBeenCalledTimes(1));

    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: /Find downloads in another folder/ })),
    );

    expect(mocks.scan).toHaveBeenLastCalledWith('E:\\Old manga');
    fireEvent.click(
      await screen.findByRole('checkbox', { name: 'Save new downloads to this folder too' }),
    );
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Restore 5 chapters' })),
    );
    expect(mocks.restore).toHaveBeenCalledWith(['a'.repeat(64), 'b'.repeat(64)], 'E:\\Old manga');
    expect(mocks.setDirectory).toHaveBeenCalledWith('E:\\Old manga');
  });

  it('asks for a folder path in a browser, which has no folder picker', async () => {
    mocks.scan.mockImplementation(async (root?: string) => (root ? empty : empty));
    render(<RestoreDownloads onRestored={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Find downloads in another folder/ }));
    fireEvent.change(screen.getByLabelText('Folder with your downloads'), {
      target: { value: '/srv/manga' },
    });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Look' })));

    expect(mocks.scan).toHaveBeenLastCalledWith('/srv/manga');
    expect(mocks.toast).toHaveBeenCalledWith({
      description: 'No downloads to restore were found in that folder.',
    });
  });
});
