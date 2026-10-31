import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const { progress, runLibraryUpdate, refresh, sendChapterAlert } = vi.hoisted(() => ({
  sendChapterAlert: vi.fn(async () => ({ sent: 1, skipped: false })),
  progress: { value: null as { done: number; total: number; title: string; found: number } | null },
  runLibraryUpdate: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('@/lib/library-store', () => ({
  useMangaLibrary: () => ({
    manga: [{ id: 'one', source: 'source-a', slug: 'one', title: 'One' }],
    loading: false,
    refresh,
  }),
  useLibraryState: () => ({ shelf: {} }),
}));
vi.mock('@/lib/app-store', () => ({
  useSetting: (_key: string, fallback: unknown) => fallback,
  useAppState: (select: (state: object) => unknown) =>
    select({ settings: {}, categoryMembers: {} }),
}));
vi.mock('@/lib/run-library-update', () => ({
  runLibraryUpdate,
  useLibraryUpdateProgress: () => progress.value,
}));
vi.mock('@/lib/library-update', () => ({
  entriesInGlobalUpdate: (library: unknown[]) => library,
  useGlobalUpdateRules: () => ({}),
}));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));
vi.mock('@projekt-manga/api-client', () => ({ sendChapterAlert }));
vi.mock('@/lib/window-notification', () => ({ showWindowNotification: vi.fn() }));

const { UpdateLibraryButton } = await import('@/components/library/update-library-button');

beforeEach(() => {
  progress.value = null;
  vi.clearAllMocks();
});

/**
 * The library toolbar's controls are icons rather than words, which is only an
 * improvement while they stay reachable by name. An icon-only button with no accessible
 * name is announced as "button" and nothing else, and these sit in a row of four that
 * would then be indistinguishable.
 */
describe('library toolbar icon buttons', () => {
  it('names the update control even though it shows no text', () => {
    render(<UpdateLibraryButton />);

    expect(screen.getByRole('button', { name: 'Update library' })).toBeInTheDocument();
    // A pointer user gets the same words on hover; aria-label alone shows nothing.
    expect(screen.getByRole('button', { name: 'Update library' })).toHaveAttribute(
      'title',
      'Update library',
    );
  });

  it('still says how far through it is, though the progress now lives in the dial', () => {
    progress.value = { done: 4, total: 12, title: 'Some title', found: 2 };
    render(<UpdateLibraryButton />);

    expect(screen.getByRole('button', { name: 'Updating library, 4 of 12' })).toBeInTheDocument();
    // Visible progress is LibraryUpdateDial's job; the button renders no bar or caption,
    // so the toolbar does not resize during an update.
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('a library update started by hand', () => {
  it('sends the outside-the-app alert when it finds chapters', async () => {
    runLibraryUpdate.mockResolvedValue({
      found: 3,
      failed: [],
      cancelled: false,
      foundByManga: { one: 3 },
      foundTitles: { one: 'One' },
    });
    const { fireEvent, waitFor } = await import('@testing-library/react');
    render(<UpdateLibraryButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Update library' }));
    await waitFor(() =>
      expect(sendChapterAlert).toHaveBeenCalledWith({ titles: [{ title: 'One', count: 3 }] }),
    );
  });

  it('sends nothing when it finds nothing', async () => {
    runLibraryUpdate.mockResolvedValue({
      found: 0,
      failed: [],
      cancelled: false,
      foundByManga: {},
      foundTitles: {},
    });
    const { fireEvent, waitFor } = await import('@testing-library/react');
    render(<UpdateLibraryButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Update library' }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(sendChapterAlert).not.toHaveBeenCalled();
  });
});
