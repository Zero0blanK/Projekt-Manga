import { useSyncExternalStore } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Manga } from '@/lib/manga-data';

const fixture = vi.hoisted(() => ({
  owner: 'anonymous',
  cachedOwner: 'anonymous',
  state: { settings: {} as Record<string, string>, categoryMembers: {} },
  listeners: new Set<() => void>(),
  search: vi.fn(),
  replacement: vi.fn(),
  original: vi.fn(),
  mark: vi.fn(),
  membership: vi.fn(),
  add: vi.fn(),
  downloads: vi.fn(),
  cancel: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: fixture.push }) }));
vi.mock('@projekt-manga/api-client', () => ({
  searchSourceMangaPage: async (...args: unknown[]) => ({
    items: await fixture.search(...args),
    hasMore: false,
  }),
  getSourceMangaDetails: fixture.replacement,
  getMangaDetailsById: fixture.original,
  markChapterAsRead: fixture.mark,
  setMangaInLibrary: fixture.membership,
  getAllDownloads: fixture.downloads,
  cancelDownload: fixture.cancel,
  buildImageProxyUrl: (url: string) => url,
}));
vi.mock('@/components/downloads/row-data', () => ({ refreshDownloads: vi.fn() }));
vi.mock('@/components/cover', () => ({ Cover: () => <span>Cover</span> }));
vi.mock('@/lib/discover-actions', () => ({ addSourceMangaToLibrary: fixture.add }));
vi.mock('@/lib/library-store', () => ({
  useSources: () => ({
    sources: [
      { id: 'old', name: 'Old', lang: 'en' },
      { id: 'new', name: 'New', lang: 'en' },
    ],
    loading: false,
  }),
  useMangaLibrary: () => ({ manga: [], refresh: fixture.refresh }),
  useLibraryState: () => ({ shelf: {}, bookmarks: [] }),
  libraryActions: { setShelf: vi.fn(), setBookmark: vi.fn() },
}));
vi.mock('@/lib/extensions-store', () => ({ useInstalledExtensions: () => ({ installed: [] }) }));
vi.mock('@/components/discover/content-privacy', () => ({
  useContentPrivacy: () => [{ hideAdult: false }],
  isAdultSource: () => false,
}));
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
  getAppState: () => fixture.state,
  useAppState: (select: (state: typeof fixture.state) => unknown) =>
    useSyncExternalStore(
      (callback) => {
        fixture.listeners.add(callback);
        return () => fixture.listeners.delete(callback);
      },
      () => select(fixture.state),
    ),
  actions: {
    toggleCategoryMember: vi.fn(),
    setSetting: (key: string, value: string) => {
      fixture.state = { ...fixture.state, settings: { ...fixture.state.settings, [key]: value } };
      fixture.listeners.forEach((callback) => callback());
      return true;
    },
  },
}));
import { SourceMigration, SourceSwitch } from '@/components/manga-detail/source-switch';
import {
  migrationReadTargets,
  parseMigrationPreferences,
  saveMigrationSearch,
  takeMigrationSearch,
} from '@/lib/migration-state';
const manga = {
  id: 'original',
  source: 'old',
  title: 'Original',
  chapters: 300,
  thumbnailUrl: null,
} as Manga;
const original = Array.from({ length: 300 }, (_, index) => ({
  id: `old-${index + 1}`,
  chapter_number: index + 1,
  is_read: true,
}));
const chapters = Array.from({ length: 160 }, (_, index) => ({
  id: `new-${index + 1}`,
  chapter_number: index + 1,
  name: 'Chapter',
  scanlator: 'Group',
}));
beforeEach(() => {
  vi.clearAllMocks();
  fixture.owner = fixture.cachedOwner = 'anonymous';
  fixture.state = { settings: {}, categoryMembers: {} };
  fixture.search.mockResolvedValue([{ id: 'replacement', title: 'Replacement', source: 'new' }]);
  fixture.original.mockResolvedValue({ chapters: original });
  fixture.replacement.mockResolvedValue({
    id: 'replacement',
    slug: 'replacement',
    title: 'Replacement',
    chapters,
  });
  fixture.mark.mockResolvedValue(undefined);
  fixture.membership.mockResolvedValue(undefined);
  fixture.add.mockResolvedValue('target');
  fixture.downloads.mockResolvedValue([
    { id: 'old-download', manga_id: 'original' },
    { id: 'other-download', manga_id: 'other' },
  ]);
  fixture.cancel.mockResolvedValue(undefined);
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});
async function openReview() {
  render(<SourceMigration manga={manga} />);
  fireEvent.click(screen.getByRole('button', { name: 'Select New' }));
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Select Replacement from New' }));
  await screen.findByRole('button', { name: 'Migrate', exact: true });
}
describe('migration lifecycle', () => {
  it('restores a search after module reload and rejects malformed tab storage', async () => {
    const snapshot = {
      query: 'kept',
      appliedQuery: 'kept',
      options: { read: true, shelf: false, bookmark: true, categories: false },
      hideUnmatched: false,
      hideAdult: false,
      results: [{ id: 'replacement', source: 'new', title: 'Replacement' }],
      status: { state: 'complete' as const, sourceIds: ['new'], settled: ['new'], failed: [] },
      scrollY: 140,
      rails: { new: 300 },
    };
    saveMigrationSearch('reload', 'manga', snapshot);
    vi.resetModules();
    const reloaded = await import('@/lib/migration-state');
    expect(reloaded.takeMigrationSearch('reload', 'manga', false)).toEqual(snapshot);
    sessionStorage.setItem(
      'projekt-manga:migration-search:["broken","manga"]',
      JSON.stringify({ version: 1, value: { ...snapshot, results: [null] } }),
    );
    expect(reloaded.takeMigrationSearch('broken', 'manga', false)).toBeNull();
  });
  it('copies only the replacement’s 160 chapters and then deletes only original downloads and removes original membership', async () => {
    await openReview();
    expect(
      screen.queryByText(/Needs review|Automatically matched chapters/),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Migrate', exact: true }));
    await screen.findByRole('heading', { name: 'Migration complete' });
    expect(fixture.mark).toHaveBeenCalledTimes(160);
    expect(new Set(fixture.mark.mock.calls.map((call) => call[1]))).toEqual(
      new Set(chapters.map((chapter) => chapter.id)),
    );
    expect(fixture.cancel).toHaveBeenCalledExactlyOnceWith('old-download');
    expect(fixture.membership.mock.calls).toEqual([
      ['target', true],
      ['original', false],
    ]);
    expect(fixture.cancel.mock.invocationCallOrder[0]).toBeGreaterThan(
      fixture.mark.mock.invocationCallOrder.at(-1)!,
    );
    expect(fixture.membership.mock.invocationCallOrder[1]).toBeGreaterThan(
      fixture.cancel.mock.invocationCallOrder[0],
    );
  });
  it('keeps the original and downloads when copying fails and retries only the failed chapter', async () => {
    fixture.mark.mockRejectedValueOnce(new Error('fixture failure'));
    await openReview();
    fireEvent.click(screen.getByRole('button', { name: 'Migrate', exact: true }));
    await screen.findByRole('button', { name: 'Retry remaining transfers' });
    expect(fixture.cancel).not.toHaveBeenCalled();
    expect(fixture.membership).not.toHaveBeenCalledWith('original', false);
    fireEvent.click(screen.getByRole('button', { name: 'Retry remaining transfers' }));
    await screen.findByRole('heading', { name: 'Migration complete' });
    expect(fixture.mark).toHaveBeenCalledTimes(161);
    expect(fixture.add).toHaveBeenCalledTimes(1);
  });
  it('does not remove original membership if download cleanup fails', async () => {
    fixture.cancel.mockRejectedValueOnce(new Error('cleanup failure'));
    await openReview();
    fireEvent.click(screen.getByRole('button', { name: 'Migrate', exact: true }));
    await screen.findByRole('button', { name: 'Retry remaining transfers' });
    expect(fixture.membership).not.toHaveBeenCalledWith('original', false);
    fireEvent.click(screen.getByRole('button', { name: 'Retry remaining transfers' }));
    await screen.findByRole('heading', { name: 'Migration complete' });
    expect(fixture.mark).toHaveBeenCalledTimes(160);
    expect(fixture.cancel).toHaveBeenCalledTimes(2);
  });
  it('persists options/source selection across titles and keeps profiles separate', async () => {
    const view = render(<SourceMigration manga={manga} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Bookmark' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select New' }));
    view.rerender(<SourceMigration manga={{ ...manga, id: 'other', title: 'Other' }} />);
    expect(screen.getByRole('switch', { name: 'Bookmark' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(
      screen.getByRole('button', { name: 'Remove New from selected sources' }),
    ).toBeInTheDocument();
    fixture.owner = fixture.cachedOwner = 'account';
    view.rerender(<SourceMigration manga={manga} />);
    expect(screen.getByRole('switch', { name: 'Bookmark' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Select New' })).toBeInTheDocument();
  });
  it('retries failed original removal without repeating completed progress or download cleanup', async () => {
    fixture.membership.mockImplementation(async (id, member) => {
      if (id === 'original' && member === false) throw new Error('removal failed');
    });
    await openReview();
    fireEvent.click(screen.getByRole('button', { name: 'Migrate', exact: true }));
    await screen.findByRole('button', { name: 'Retry remaining transfers' });
    fixture.membership.mockResolvedValue(undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Retry remaining transfers' }));
    await screen.findByRole('heading', { name: 'Migration complete' });
    expect(fixture.mark).toHaveBeenCalledTimes(160);
    expect(fixture.cancel).toHaveBeenCalledTimes(1);
    expect(fixture.add).toHaveBeenCalledTimes(1);
  });
  it('stops cleanup and original removal when the profile changes', async () => {
    fixture.cancel.mockImplementation(async () => {
      fixture.cachedOwner = 'another-account';
    });
    fixture.downloads.mockResolvedValue([
      { id: 'first', manga_id: 'original' },
      { id: 'second', manga_id: 'original' },
    ]);
    await openReview();
    fireEvent.click(screen.getByRole('button', { name: 'Migrate', exact: true }));
    await waitFor(() => expect(fixture.cancel).toHaveBeenCalledTimes(1));
    expect(fixture.cancel).toHaveBeenCalledWith('first');
    expect(fixture.membership).not.toHaveBeenCalledWith('original', false);
    expect(screen.queryByRole('heading', { name: 'Migration complete' })).not.toBeInTheDocument();
  });
  it('uses an accessible migration icon link on manga details', () => {
    render(<SourceSwitch manga={manga} />);
    const link = screen.getByRole('link', { name: 'Migrate manga' });
    expect(link).toHaveAttribute('href', '/manga/original/migrate');
    expect(link.textContent).toBe('');
  });
  it('matches exact numbers including fractional chapters, duplicates and sparse progress', () => {
    expect(
      migrationReadTargets(
        [
          { chapter_number: 0, is_read: true },
          { chapter_number: 0.5, is_read: true },
          { chapter_number: 2, is_read: false },
        ],
        [
          { id: 'zero', chapter_number: 0 },
          { id: 'half-a', chapter_number: 0.5 },
          { id: 'half-b', chapter_number: 0.5 },
          { id: 'unread', chapter_number: 2 },
          { id: 'absent', chapter_number: 1 },
        ],
      ),
    ).toEqual(new Set(['zero', 'half-a', 'half-b']));
  });
  it('validates saved preferences and restores only the originating profile/title/privacy search snapshot', () => {
    expect(
      parseMigrationPreferences({
        sourceOrder: ['a', 'a', null],
        options: { read: false, bookmark: 'bad' },
      }),
    ).toMatchObject({ sourceOrder: ['a'], options: { read: false, bookmark: true } });
    const snapshot = {
      query: 'query',
      appliedQuery: 'query',
      options: { read: true, shelf: true, bookmark: true, categories: true },
      hideUnmatched: false,
      hideAdult: false,
      results: [],
      status: { state: 'complete' as const, sourceIds: ['new'], settled: ['new'], failed: [] },
      scrollY: 120,
      rails: { new: 200 },
    };
    saveMigrationSearch('anonymous', 'one', snapshot);
    expect(takeMigrationSearch('account', 'one', false)).toBeNull();
    expect(takeMigrationSearch('anonymous', 'two', false)).toBeNull();
    expect(takeMigrationSearch('anonymous', 'one', false)).toEqual(snapshot);
    expect(takeMigrationSearch('anonymous', 'one', false)).toBeNull();
  });
});
