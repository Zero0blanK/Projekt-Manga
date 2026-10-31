import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { Mangas } from '@projekt-manga/types';

vi.mock('@/lib/library-store', () => ({
  useMangaLibrary: () => ({
    manga: [
      { source: 'source-a', slug: 'in-library', inLibrary: true },
      // A shadow row (read, never added) is not "in the library".
      { source: 'source-a', slug: 'shadow-only', inLibrary: false },
      // The same slug from another source is a different title.
      { source: 'source-b', slug: 'other-source', inLibrary: true },
    ],
    loading: false,
  }),
}));

const { actions, clearSetting } = await import('@/lib/app-store');
const { HIDE_LIBRARY_IN_SOURCES, useVisibleSourceResults } = await import('@/lib/library-titles');

const result = (id: string, source = 'source-a'): Mangas => ({
  id,
  slug: id,
  title: id,
  source,
  thumbnail_url: '',
});
const items = [
  result('in-library'),
  result('shadow-only'),
  result('other-source'),
  result('new-title'),
];

afterEach(() => act(() => clearSetting(HIDE_LIBRARY_IN_SOURCES)));

describe('hiding library titles in source results', () => {
  it('shows every result while the setting is off, which is the default', () => {
    const { result: hook } = renderHook(() => useVisibleSourceResults(items, 'source-a'));
    expect(hook.current.visible).toEqual(items);
    expect(hook.current.hidden).toBe(0);
  });

  it('leaves out only titles in the library from the same source once turned on', () => {
    const { result: hook } = renderHook(() => useVisibleSourceResults(items, 'source-a'));
    act(() => actions.setSetting(HIDE_LIBRARY_IN_SOURCES, true));

    expect(hook.current.visible.map((m) => m.id)).toEqual([
      'shadow-only',
      'other-source',
      'new-title',
    ]);
    expect(hook.current.hidden).toBe(1);
  });

  it('matches each result by its own source when the list mixes sources', () => {
    const mixed = [result('other-source', 'source-b'), result('other-source')];
    const { result: hook } = renderHook(() => useVisibleSourceResults(mixed));
    act(() => actions.setSetting(HIDE_LIBRARY_IN_SOURCES, true));

    expect(hook.current.visible).toEqual([mixed[1]]);
  });
});
