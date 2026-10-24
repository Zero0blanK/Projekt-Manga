import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { actions } from '@/lib/app-store';
import { queryClient, queryKeys } from '@/lib/query-client';
import { sourceLanguageValues, useSourceDisplayLanguage } from '@/lib/source-display-language';
import { DiscoverPageClient } from '@/app/discover/client';
import type { MangaFilter } from '@projekt-manga/types';
import { browseQueryKey } from '@/lib/browse-state';

const state = vi.hoisted(() => ({ user: null as { id: string } | null }));
vi.mock('@/lib/source-health-status', () => ({ useSourceHealthStatus: () => 'ok' }));
vi.mock('@/lib/session-resource', () => ({
  useCurrentUser: () => ({ user: state.user, loading: false }),
}));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), back: vi.fn() }),
}));
vi.mock('@/lib/library-store', () => ({
  useSources: () => ({
    loading: false,
    sources: [
      { id: 'a', name: 'A', lang: 'en', isNSFW: false },
      { id: 'b', name: 'B', lang: 'es', isNSFW: false },
    ],
  }),
}));
vi.mock('@/lib/extensions-store', () => ({
  useInstalledExtensions: () => ({ installed: [] }),
  useSourceCatalog: () => ({ entries: [] }),
}));
vi.mock('@/components/discover/content-privacy', () => ({
  useContentPrivacy: () => [{ hideAdult: false }],
  isAdultSource: () => false,
}));
vi.mock('@/components/discover/source-catalog', () => ({
  SourceCatalog: () => <span>Extension catalogue</span>,
}));
vi.mock('@/components/discover/installed-source-card', () => ({
  InstalledSourceCard: ({ source }: { source: { id: string; name: string } }) => {
    const [language, setLanguage] = useSourceDisplayLanguage(source.id);
    return (
      <article>
        <h2>{source.name}</h2>
        <output aria-label={`${source.name} language`}>{language}</output>
        <button onClick={() => setLanguage('en')}>English for {source.name}</button>
      </article>
    );
  },
}));
beforeEach(() => {
  actions.resetAll();
  queryClient.clear();
  state.user = null;
  queryClient.setQueryData(queryKeys.session, null);
});
afterEach(() => {
  cleanup();
  actions.resetAll();
  queryClient.clear();
});
describe('source display languages', () => {
  it('separates saved browse results by display language while retaining older default keys', () => {
    const snapshot = {
      sourceId: 'a',
      category: 'latest',
      query: '',
      sortValue: '',
      filterValues: {},
    };
    const original = browseQueryKey('latest', snapshot);
    expect(browseQueryKey('latest', { ...snapshot, displayLanguage: 'all' })).toBe(original);
    expect(browseQueryKey('latest', { ...snapshot, displayLanguage: 'en' })).not.toBe(original);
    expect(browseQueryKey('latest', { ...snapshot, displayLanguage: 'en' })).not.toBe(
      browseQueryKey('latest', { ...snapshot, displayLanguage: 'ja' }),
    );
  });
  it('persists a separate preference for each source and account', () => {
    const hook = renderHook(
      () => [useSourceDisplayLanguage('a'), useSourceDisplayLanguage('b')] as const,
    );
    act(() => hook.result.current[0][1]('en'));
    expect(hook.result.current[0][0]).toBe('en');
    expect(hook.result.current[1][0]).toBe('all');
    act(() => {
      state.user = { id: 'other' };
      queryClient.setQueryData(queryKeys.session, state.user);
    });
    hook.rerender();
    expect(hook.result.current[0][0]).toBe('all');
    act(() => {
      state.user = null;
      queryClient.setQueryData(queryKeys.session, null);
    });
    hook.rerender();
    expect(hook.result.current[0][0]).toBe('en');
    hook.unmount();
    const restored = renderHook(() => useSourceDisplayLanguage('a'));
    expect(restored.result.current[0]).toBe('en');
  });
  it('keeps other cards and extensions visible when a card language changes, including old global preferences', () => {
    actions.setSetting(
      'profile:anonymous:discoverLanguages',
      JSON.stringify({ version: 1, value: ['en'] }),
    );
    render(<DiscoverPageClient />);
    fireEvent.click(screen.getByRole('button', { name: 'English for A' }));
    expect(screen.getByRole('heading', { name: 'B' })).toBeInTheDocument();
    expect(screen.getByLabelText('A language')).toHaveTextContent('en');
    expect(screen.getByLabelText('B language')).toHaveTextContent('all');
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Extensions' }), { button: 0 });
    expect(screen.getByText('Extension catalogue')).toBeInTheDocument();
  });
  it('only sends a language filter advertised by that source', () => {
    const filters = [
      {
        value: 'language',
        name: 'Language',
        type: 'select',
        options: [
          { value: 'all', label: 'All' },
          { value: 'en', label: 'English' },
        ],
      },
    ] as MangaFilter[];
    expect(sourceLanguageValues(filters, 'en')).toEqual({ language: 'en' });
    expect(sourceLanguageValues(filters, 'es')).toEqual({});
    expect(sourceLanguageValues([], 'en')).toEqual({});
    expect(sourceLanguageValues(filters, 'all')).toEqual({});
  });
});
