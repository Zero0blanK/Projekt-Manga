import userEvent from '@testing-library/user-event';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  session: { user: null as { id: string } | null, loading: false },
  languages: ['en', 'en', 'en'],
}));
vi.mock('@/lib/source-health-status', () => ({ useSourceHealthStatus: () => 'ok' }));
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
  useInstalledExtensions: () => ({ installed: [] }),
  useSourceCatalog: () => ({ entries: [] }),
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
  it('separates language sections, groups English regions and keeps pin movement inside each language', async () => {
    mocks.languages = ['en-US', 'ja', 'en'];
    const user = userEvent.setup();
    render(<DiscoverPageClient />);
    const english = screen.getByRole('region', { name: 'English installed sources' });
    const japanese = screen.getByRole('region', { name: 'Japanese installed sources' });
    expect(within(english).getAllByRole('article')).toHaveLength(2);
    expect(within(japanese).getAllByRole('article')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Pin Source A' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pin Source B' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pin Source C' }));
    await user.click(screen.getByRole('button', { name: 'Options for Source C' }));
    await user.click(screen.getByRole('menuitem', { name: 'Move pin up' }));
    expect(
      within(english)
        .getAllByRole('article')
        .map((article) => within(article).getByRole('heading').textContent),
    ).toEqual(['Source C', 'Source A']);
    expect(within(japanese).getByRole('heading', { name: 'Source B' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Options for Source B' }));
    expect(screen.getByRole('menuitem', { name: 'Move pin up' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByRole('menuitem', { name: 'Move pin down' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });
});
