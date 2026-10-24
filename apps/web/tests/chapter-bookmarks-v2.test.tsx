import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useChapterBookmarks } from '@/lib/chapter-bookmarks';
import { actions } from '@/lib/app-store';
import { queryClient } from '@/lib/query-client';
vi.mock('@/lib/session-resource', () => ({
  useCurrentUser: () => ({ user: null, loading: false }),
}));
beforeEach(() => {
  actions.resetAll();
  queryClient.clear();
});
afterEach(() => {
  cleanup();
  actions.resetAll();
  queryClient.clear();
});

it('honors restored chapter bookmarks and persists an explicit local unbookmark across remounts', () => {
  const chapters = [
    { id: 'restored', is_bookmark: true },
    { id: 'other', is_bookmark: false },
  ];
  const first = renderHook(() => useChapterBookmarks(chapters));
  expect(first.result.current.isBookmarked('restored')).toBe(true);
  act(() => first.result.current.toggle('restored'));
  expect(first.result.current.isBookmarked('restored')).toBe(false);
  first.unmount();
  const next = renderHook(() => useChapterBookmarks(chapters));
  expect(next.result.current.isBookmarked('restored')).toBe(false);
  act(() => next.result.current.toggle('other'));
  expect(next.result.current.isBookmarked('other')).toBe(true);
  act(() => next.result.current.toggle('restored'));
  expect(next.result.current.isBookmarked('restored')).toBe(true);
});
