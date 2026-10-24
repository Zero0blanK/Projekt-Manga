import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Manga } from '@/lib/manga-data';

/**
 * Bulk actions live in the floating selection bar (long-press or Space selects titles;
 * the bar's menu acts on them). These tests cover the bulk-mutation guarantees.
 */
const fixture = vi.hoisted(() => ({
  owner: 'anonymous',
  cachedOwner: 'anonymous',
  bookmark: vi.fn(),
  shelf: vi.fn(),
  remove: vi.fn(),
  category: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('@projekt-manga/api-client', () => ({ setMangaInLibrary: fixture.remove }));
vi.mock('@/lib/library-store', () => ({
  libraryActions: { setBookmark: fixture.bookmark, setShelf: fixture.shelf },
  useLibraryState: () => ({ bookmarks: [] }),
}));
vi.mock('@/hooks/use-toast', () => ({ toast: fixture.toast }));
vi.mock('@/lib/session-resource', () => ({
  useCurrentUser: () => ({
    user: fixture.owner === 'anonymous' ? null : { id: fixture.owner },
    loading: false,
  }),
}));
vi.mock('@/lib/query-client', () => ({
  queryKeys: { session: ['session'] },
  queryClient: {
    getQueryData: () => (fixture.cachedOwner === 'anonymous' ? null : { id: fixture.cachedOwner }),
  },
}));
vi.mock('@/lib/app-store', () => ({
  useAppState: (select: (state: object) => unknown) => select({ customCategories: ['Favorites'] }),
  getAppState: () => ({ categoryMembers: { Favorites: ['m0'] } }),
  actions: { toggleCategoryMember: fixture.category },
}));
const { LibrarySelectionBar } = await import('@/components/library/library-tools');
const manga = Array.from({ length: 7 }, (_, i) => ({
  id: `m${i}`,
  title: `Title ${i}`,
})) as Manga[];
const refresh = vi.fn();

function Harness({ initial = manga.map((item) => item.id) }: { initial?: string[] }) {
  // Selection starts empty (the bar clears it whenever the profile is established), so the
  // test selects after mount, as the long-press gesture would.
  const [selected, setSelected] = useState<string[]>([]);
  // A positive request opens the actions menu, as the long-press gesture does.
  const [request, setRequest] = useState(0);
  return (
    <>
      <button onClick={() => setSelected(initial)}>Pick titles</button>
      <button onClick={() => setRequest((value) => value + 1)}>Open actions</button>
      <LibrarySelectionBar
        manga={manga}
        visible={manga}
        selected={selected}
        setSelected={setSelected}
        refresh={refresh}
        actionsRequest={request}
      />
    </>
  );
}
function openActions() {
  fireEvent.click(screen.getByText('Pick titles'));
  fireEvent.click(screen.getByText('Open actions'));
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('v2 library actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fixture.owner = fixture.cachedOwner = 'anonymous';
    fixture.bookmark.mockResolvedValue(undefined);
    fixture.shelf.mockResolvedValue(undefined);
    fixture.remove.mockResolvedValue(undefined);
  });

  it('limits mutations to three workers and retains only failures for retry', async () => {
    const gates = Array.from({ length: 3 }, deferred);
    fixture.bookmark
      .mockImplementationOnce(() => gates[0].promise)
      .mockImplementationOnce(() => gates[1].promise)
      .mockImplementationOnce(() => gates[2].promise)
      .mockRejectedValueOnce(new Error('offline'));
    render(<Harness />);
    openActions();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Bookmark' }));
    expect(fixture.bookmark).toHaveBeenCalledTimes(3);
    await act(async () => {
      gates.forEach((gate) => gate.resolve());
    });
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('1 selected'));
    expect(fixture.toast).toHaveBeenLastCalledWith({
      description: '1 title could not be updated. Retry the remaining selection.',
    });
    fireEvent.click(screen.getByText('Open actions'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Bookmark' }));
    await waitFor(() => expect(screen.queryByRole('toolbar')).not.toBeInTheDocument());
    expect(fixture.bookmark).toHaveBeenLastCalledWith('m3', true);
  });

  it('stops starting writes after the current profile changes', async () => {
    const gate = deferred();
    fixture.bookmark.mockImplementation(() => gate.promise);
    const view = render(<Harness />);
    openActions();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Bookmark' }));
    fixture.owner = fixture.cachedOwner = 'next-account';
    view.rerender(<Harness />);
    await act(async () => gate.resolve());
    expect(fixture.bookmark).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('requires confirmation for removal and leaves history/files outside the mutation', async () => {
    render(<Harness />);
    openActions();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove from library' }));
    expect(fixture.remove).not.toHaveBeenCalled();
    expect(await screen.findByRole('alertdialog')).toHaveTextContent(
      'Reading history, chapter progress and downloaded files are retained.',
    );
    fireEvent.click(screen.getByText('Cancel'));
    expect(fixture.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Open actions'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove from library' }));
    fireEvent.click(await screen.findByText('Remove titles'));
    await waitFor(() => expect(fixture.remove).toHaveBeenCalledTimes(7));
    expect(fixture.remove).toHaveBeenCalledWith('m0', false);
  });

  it('words the removal prompt for a single title', async () => {
    render(<Harness initial={['m2']} />);
    openActions();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove from library' }));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent(
      'Remove this title from your library?',
    );
    expect(screen.getByText('Remove title')).toBeInTheDocument();
  });
});
