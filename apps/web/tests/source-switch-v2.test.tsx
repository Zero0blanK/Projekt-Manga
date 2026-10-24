import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Manga } from '@/lib/manga-data';

/**
 * The assisted "Switch source" modal was replaced by the dedicated migration page
 * (/manga/[id]/migrate). Lifecycle, transfer and retry behaviour is covered by
 * migration-workflow.test.tsx; this file covers privacy filtering and what the review step
 * tells the reader before anything is copied.
 */
const fixture = vi.hoisted(() => ({
  hideAdult: false,
  search: vi.fn(),
  replacement: vi.fn(),
  original: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@projekt-manga/api-client', () => ({
  searchSourceMangaPage: async (...args: unknown[]) => ({
    items: await fixture.search(...args),
    hasMore: false,
  }),
  getSourceMangaDetails: fixture.replacement,
  getMangaDetailsById: fixture.original,
  markChapterAsRead: vi.fn(),
  setMangaInLibrary: vi.fn(),
  getAllDownloads: vi.fn().mockResolvedValue([]),
  cancelDownload: vi.fn(),
  buildImageProxyUrl: (url: string) => url,
}));
vi.mock('@/components/downloads/row-data', () => ({ refreshDownloads: vi.fn() }));
vi.mock('@/components/cover', () => ({ Cover: () => <span>Cover</span> }));
vi.mock('@/lib/discover-actions', () => ({ addSourceMangaToLibrary: vi.fn() }));
vi.mock('@/lib/library-store', () => ({
  useSources: () => ({
    sources: [
      { id: 'old', name: 'Original', lang: 'en' },
      { id: 'new', name: 'New', lang: 'fr' },
      { id: 'adult', name: 'Adult source', lang: 'all', isNSFW: true },
      { id: 'mixed', name: 'Mixed source', lang: 'en', isNSFW: true },
    ],
    loading: false,
  }),
  useMangaLibrary: () => ({ manga: [], refresh: vi.fn() }),
  useLibraryState: () => ({ shelf: {}, bookmarks: [] }),
  libraryActions: { setShelf: vi.fn(), setBookmark: vi.fn() },
}));
vi.mock('@/lib/extensions-store', () => ({
  useInstalledExtensions: () => ({ installed: [{ source_key: 'mixed', content_rating: 'mixed' }] }),
}));
vi.mock('@/components/discover/content-privacy', () => ({
  useContentPrivacy: () => [{ hideAdult: fixture.hideAdult }],
  isAdultSource: (rating: string | undefined, adult: boolean) =>
    rating === 'nsfw' || (!rating && adult),
}));
vi.mock('@/lib/session-resource', () => ({
  useCurrentUser: () => ({ user: null, loading: false }),
}));
vi.mock('@/lib/query-client', () => ({
  queryKeys: { session: ['session'] },
  queryClient: { getQueryData: () => null },
}));
// Migration preferences (selected sources, options) persist through the app store, so the
// mock has to be a real, subscribable store for a selection to survive a re-render.
const store = vi.hoisted(() => ({
  state: { settings: {} as Record<string, string>, categoryMembers: {} },
  listeners: new Set<() => void>(),
}));
vi.mock('@/lib/app-store', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    getAppState: () => store.state,
    useAppState: (select: (state: typeof store.state) => unknown) =>
      useSyncExternalStore(
        (callback) => {
          store.listeners.add(callback);
          return () => store.listeners.delete(callback);
        },
        () => select(store.state),
      ),
    actions: {
      toggleCategoryMember: vi.fn(),
      setSetting: (key: string, value: string) => {
        store.state = { ...store.state, settings: { ...store.state.settings, [key]: value } };
        store.listeners.forEach((callback) => callback());
        return true;
      },
    },
  };
});

const { SourceMigration } = await import('@/components/manga-detail/source-switch');
const manga = { id: 'manga', title: 'Original', source: 'old', chapters: 4 } as Manga;

function availableSourceNames() {
  const region = screen.getByRole('region', { name: /^Available/ });
  return within(region)
    .queryAllByRole('button')
    .map((button) => button.getAttribute('aria-label'));
}

async function openReview() {
  render(<SourceMigration manga={manga} />);
  fireEvent.click(screen.getByRole('button', { name: 'Select New' }));
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Select Replacement from New' }));
  await screen.findByRole('button', { name: 'Migrate', exact: true });
}

describe('migration source privacy and review copy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.state = { settings: {}, categoryMembers: {} };
    fixture.hideAdult = false;
    fixture.search.mockResolvedValue([{ id: 'replacement', title: 'Replacement', source: 'new' }]);
    fixture.replacement.mockResolvedValue({
      id: 'replacement',
      slug: 'replacement',
      title: 'Replacement',
      chapters: [
        { id: 'new-1', chapter_number: 1, name: 'First', scanlator: 'A' },
        { id: 'new-2', chapter_number: 2, name: 'Second', scanlator: 'A' },
      ],
    });
    fixture.original.mockResolvedValue({
      chapters: [
        { id: 'old-1', chapter_number: 1, is_read: false },
        { id: 'old-2', chapter_number: 2, is_read: false },
        { id: 'old-3', chapter_number: 3, is_read: false },
        { id: 'old-4', chapter_number: 4, is_read: false },
      ],
    });
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  });

  it('never offers the current source, and hides adult sources while keeping mixed catalogues', () => {
    fixture.hideAdult = true;
    render(<SourceMigration manga={manga} />);
    expect(availableSourceNames()).toEqual(['Select New', 'Select Mixed source']);
  });

  it('offers every other source when adult content is shown', () => {
    render(<SourceMigration manga={manga} />);
    expect(availableSourceNames()).toEqual([
      'Select New',
      'Select Adult source',
      'Select Mixed source',
    ]);
  });

  it('shows source languages by name rather than code', () => {
    render(<SourceMigration manga={manga} />);
    expect(screen.getByRole('button', { name: 'Select New' })).toHaveTextContent('French');
  });

  it('explains when there is no completed progress and when the replacement has fewer chapters', async () => {
    await openReview();
    expect(
      screen.getByText(/haven't finished any chapters of the original yet/),
    ).toBeInTheDocument();
    expect(screen.getByText(/lists 2 fewer chapters than/)).toBeInTheDocument();
  });

  it('labels each migration step for assistive technology', async () => {
    await openReview();
    expect(
      screen.getByRole('button', { name: 'Step 1 of 3: Choose sources, completed' }),
    ).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Step 3 of 3: Review' })).toHaveAttribute(
      'aria-current',
      'step',
    );
  });
});
