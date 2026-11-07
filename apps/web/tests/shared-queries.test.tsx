import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getHistory, getAllDownloads, session } = vi.hoisted(() => ({
  getHistory: vi.fn(),
  getAllDownloads: vi.fn(),
  session: { user: null as { id: string } | null, loading: false },
}));

vi.mock('@projekt-manga/api-client', () => ({ getHistory, getAllDownloads }));
vi.mock('@/lib/session-resource', () => ({ useCurrentUser: () => session }));

import {
  fetchDownloads,
  invalidateDownloads,
  invalidateHistory,
  useDownloads,
  useHistory,
} from '@/lib/shared-queries';

beforeEach(() => {
  session.user = null;
  session.loading = false;
  getHistory.mockReset().mockResolvedValue([{ id: 'h1' }]);
  getAllDownloads.mockReset().mockResolvedValue([{ id: 'd1' }]);
});

describe('shared history and downloads', () => {
  it('makes one request however many screens want the list', async () => {
    const first = renderHook(() => useHistory());
    const second = renderHook(() => useHistory());

    await waitFor(() => expect(first.result.current.data).toHaveLength(1));
    await waitFor(() => expect(second.result.current.data).toHaveLength(1));

    expect(getHistory).toHaveBeenCalledTimes(1);
  });

  it('keeps each account to its own copy', async () => {
    session.user = { id: 'ann' };
    const { result, rerender } = renderHook(() => useHistory());
    await waitFor(() => expect(result.current.data).toHaveLength(1));

    getHistory.mockResolvedValue([]);
    session.user = { id: 'bob' };
    rerender();

    expect(result.current.data).toBeUndefined();
    await waitFor(() => expect(result.current.data).toEqual([]));
  });

  it('waits for the session, and for a screen that only sometimes needs it', async () => {
    session.loading = true;
    const loading = renderHook(() => useHistory());
    session.loading = false;
    const disabled = renderHook(() => useDownloads({ enabled: false }));

    await act(async () => {});

    expect(loading.result.current.fetchStatus).toBe('idle');
    expect(getHistory).not.toHaveBeenCalled();
    expect(disabled.result.current.fetchStatus).toBe('idle');
    expect(getAllDownloads).not.toHaveBeenCalled();
  });

  it('refreshes screens when a write invalidates the list', async () => {
    const { result } = renderHook(() => useDownloads());
    await waitFor(() => expect(result.current.data).toHaveLength(1));

    getAllDownloads.mockResolvedValue([{ id: 'd1' }, { id: 'd2' }]);
    await act(() => invalidateDownloads());

    await waitFor(() => expect(result.current.data).toHaveLength(2));
  });

  it('refreshes screens when the server list is read directly', async () => {
    const { result } = renderHook(() => useDownloads());
    await waitFor(() => expect(result.current.data).toHaveLength(1));

    getAllDownloads.mockResolvedValue([]);
    await act(() => fetchDownloads(null));

    await waitFor(() => expect(result.current.data).toEqual([]));
  });

  it('never answers an imperative read from cache', async () => {
    await fetchDownloads(null);
    await fetchDownloads(null);

    expect(getAllDownloads).toHaveBeenCalledTimes(2);
  });

  it('leaves a failure for the screen to show, without retrying', async () => {
    getHistory.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useHistory());

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(getHistory).toHaveBeenCalledTimes(1);

    getHistory.mockResolvedValue([]);
    await act(() => invalidateHistory());
    await waitFor(() => expect(result.current.data).toEqual([]));
  });
});
