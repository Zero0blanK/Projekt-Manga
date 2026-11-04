import userEvent from '@testing-library/user-event';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  session: { user: null as { id: string } | null, loading: false },
  languages: ['en', 'en', 'en'],
  installed: [] as Array<{ source_key: string; repository_id: string; content_rating: null }>,
  repositories: [] as Array<{ id: string; url: string; name: string | null }>,
}));
vi.mock('@/lib/source-health-status', () => ({
  useSourceHealthStatus: () => 'ok',
  summarizeSourceHealth: () => 'ok',
}));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), back: vi.fn() }),
}));
vi.mock('@/lib/session-resource', () => ({ useCurrentUser: () => mocks.session }));
vi.mock('@/lib/library-store', () => ({
  useSourceFilters: () => ({ filters: [] }),
  useSourceCapabilities: () => ({
    capabilities: { latest: true, search: true, languageFilter: false },
  }),
  useSources: () => ({
    loading: false,
    sources: ['A', 'B', 'C'].map((name, index) => ({
      id: name.toLowerCase(),
      name: `Source ${name}`,
      lang: mocks.languages[index],
      base_url: `https://${name.toLowerCase()}.example.com`,
      isNSFW: false,
    })),
  }),
}));
vi.mock('@/lib/extensions-store', () => ({
  useInstalledExtensions: () => ({ installed: mocks.installed }),
  useSourceCatalog: () => ({ entries: [], repositories: mocks.repositories }),
}));
vi.mock('@/components/discover/first-use-setup', () => ({ FirstUseSetup: () => null }));
vi.mock('@/components/discover/source-catalog', () => ({ SourceCatalog: () => null }));
vi.mock('@/components/discover/content-privacy', () => ({
  useContentPrivacy: () => [{ hideAdult: false }],
  isAdultSource: () => false,
}));
vi.mock('@/components/discover/source-health-summary', () => ({
  useSourceHealthSummary: () => ({}),
  SourceHealthSummary: () => null,
}));
import { DiscoverPageClient } from '@/app/discover/client';
import { actions } from '@/lib/app-store';
import { queryClient, queryKeys } from '@/lib/query-client';
beforeEach(() => {
  mocks.session = { user: null, loading: false };
  mocks.languages = ['en', 'en', 'en'];
  mocks.installed = [];
  mocks.repositories = [];
  actions.resetAll();
  queryClient.clear();
  queryClient.setQueryData(queryKeys.session, null);
});
afterEach(() => {
  cleanup();
  actions.resetAll();
  queryClient.clear();
});
const sourceOrder = () =>
  screen.getAllByRole('article').map((article) => within(article).getByRole('heading').textContent);
describe('Source pin ordering and device persistence', () => {
  it('pins, reorders, restores across remounts and unpins without removing the source', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<DiscoverPageClient />);
    fireEvent.click(screen.getByRole('button', { name: 'Pin Source C' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pin Source B' }));
    expect(sourceOrder()).toEqual(['Source C', 'Source B', 'Source A']);
    await user.click(screen.getByRole('button', { name: 'Options for Source C' }));
    expect(screen.getByRole('menuitem', { name: 'Move pin up' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Options for Source B' }));
    await user.click(screen.getByRole('menuitem', { name: 'Move pin up' }));
    expect(sourceOrder()).toEqual(['Source B', 'Source C', 'Source A']);
    unmount();
    render(<DiscoverPageClient />);
    expect(sourceOrder()).toEqual(['Source B', 'Source C', 'Source A']);
    fireEvent.click(screen.getByRole('button', { name: 'Unpin Source B' }));
    expect(sourceOrder()).toEqual(['Source C', 'Source A', 'Source B']);
    expect(screen.getByRole('button', { name: 'Pin Source B' })).toBeInTheDocument();
  });
  it('keeps each profile pin order independent', () => {
    const { rerender } = render(<DiscoverPageClient />);
    fireEvent.click(screen.getByRole('button', { name: 'Pin Source C' }));
    mocks.session.user = { id: 'other' };
    queryClient.setQueryData(queryKeys.session, mocks.session.user);
    rerender(<DiscoverPageClient />);
    expect(sourceOrder()).toEqual(['Source A', 'Source B', 'Source C']);
    fireEvent.click(screen.getByRole('button', { name: 'Pin Source B' }));
    expect(sourceOrder()).toEqual(['Source B', 'Source A', 'Source C']);
    mocks.session.user = null;
    queryClient.setQueryData(queryKeys.session, null);
    rerender(<DiscoverPageClient />);
    expect(sourceOrder()).toEqual(['Source C', 'Source A', 'Source B']);
  });
  it('orders sections pinned, multilingual, English, then other languages by name', () => {
    mocks.languages = ['ja', 'all', 'en-US'];
    render(<DiscoverPageClient />);
    const regions = () =>
      screen.getAllByRole('region').map((region) => region.getAttribute('aria-label'));
    expect(regions()).toEqual([
      'Multilingual installed sources',
      'English installed sources',
      'Japanese installed sources',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Pin Source A' }));
    // A pinned source moves to Pinned and leaves its own language's section.
    expect(regions()).toEqual([
      'Pinned installed sources',
      'Multilingual installed sources',
      'English installed sources',
    ]);
    const pinned = screen.getByRole('region', { name: 'Pinned installed sources' });
    expect(within(pinned).getByRole('heading', { name: 'Source A' })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { name: 'Source A' })).toHaveLength(1);
  });

  it('moves pins across languages within the pinned section', async () => {
    mocks.languages = ['en', 'ja', 'all'];
    const user = userEvent.setup();
    render(<DiscoverPageClient />);
    fireEvent.click(screen.getByRole('button', { name: 'Pin Source A' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pin Source B' }));
    const pinned = () =>
      within(screen.getByRole('region', { name: 'Pinned installed sources' }))
        .getAllByRole('article')
        .map((article) => within(article).getByRole('heading').textContent);
    expect(pinned()).toEqual(['Source A', 'Source B']);
    await user.click(screen.getByRole('button', { name: 'Options for Source B' }));
    await user.click(screen.getByRole('menuitem', { name: 'Move pin up' }));
    expect(pinned()).toEqual(['Source B', 'Source A']);
  });

  it('filters installed sources by language and rating', async () => {
    mocks.languages = ['en', 'ja', 'en'];
    const user = userEvent.setup();
    render(<DiscoverPageClient />);
    await user.click(screen.getByRole('button', { name: /^Language/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Japanese' }));
    expect(sourceOrder()).toEqual(['Source B']);
    expect(screen.getByRole('status')).toHaveTextContent('1 source');
    await user.click(screen.getByRole('button', { name: 'Reset filters' }));
    expect(sourceOrder()).toEqual(['Source A', 'Source C', 'Source B']);
    await user.click(screen.getByRole('button', { name: /^Content rating/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Adult' }));
    expect(screen.queryAllByRole('article')).toHaveLength(0);
    // One place the sources come from, so no repository choice.
    expect(screen.queryByRole('button', { name: /^Source repository/ })).toBeNull();
  });

  it('filters installed sources by the repository author they came from', async () => {
    mocks.installed = [
      { source_key: 'a', repository_id: 'r1', content_rating: null },
      { source_key: 'b', repository_id: 'r2', content_rating: null },
      { source_key: 'c', repository_id: 'r1', content_rating: null },
    ];
    mocks.repositories = [
      {
        id: 'r1',
        url: 'https://raw.githubusercontent.com/Alice/sources/main/index.json',
        name: null,
      },
      {
        id: 'r2',
        url: 'https://raw.githubusercontent.com/Bob/sources/main/index.json',
        name: null,
      },
    ];
    const user = userEvent.setup();
    render(<DiscoverPageClient />);
    await user.click(screen.getByRole('button', { name: /^Source repository/ }));
    const options = await screen.findAllByRole('menuitem');
    expect(options.map((option) => option.textContent)).toEqual(['All', 'Alice', 'Bob']);
    await user.click(options[2]);
    expect(sourceOrder()).toEqual(['Source B']);
  });
});
