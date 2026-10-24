import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, logout } from '@projekt-manga/api-client';
import { queryClient, queryKeys } from '@/lib/query-client';
import { sessionActions } from '@/lib/session-resource';

const mocks = vi.hoisted(() => ({
  apiLogout: vi.fn(),
  clearCachedSession: vi.fn(),
  setQueryData: vi.fn(),
  invalidateQueries: vi.fn(),
  cancelLibraryUpdate: vi.fn(),
}));

vi.mock('@/lib/run-library-update', () => ({ cancelLibraryUpdate: mocks.cancelLibraryUpdate }));

vi.mock('@projekt-manga/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@projekt-manga/api-client')>();
  return { ...actual, logout: mocks.apiLogout };
});

vi.mock('@/lib/query-client', () => ({
  queryClient: {
    setQueryData: mocks.setQueryData,
    invalidateQueries: mocks.invalidateQueries,
  },
  queryKeys: {
    session: ['session'],
    mangaLibrary: ['manga-library'],
    libraryState: ['library-state'],
  },
}));

describe('sessionActions.logout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.apiLogout.mockResolvedValue(null);
    mocks.clearCachedSession.mockResolvedValue({ success: true });
    Object.defineProperty(window, 'desktop', {
      configurable: true,
      value: { auth: { clearCachedSession: mocks.clearCachedSession } },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'desktop');
  });

  it('clears renderer and desktop session state when the server reports an expired session', async () => {
    mocks.apiLogout.mockRejectedValue(new ApiError('Session expired', 401, 'http'));

    await expect(sessionActions.logout()).resolves.toBeUndefined();

    expect(mocks.clearCachedSession).toHaveBeenCalledOnce();
    expect(mocks.cancelLibraryUpdate).toHaveBeenCalledOnce();
    expect(queryClient.setQueryData).toHaveBeenCalledWith(queryKeys.session, null);
  });

  it('preserves local session state when logout fails for a network reason', async () => {
    mocks.apiLogout.mockRejectedValue(new ApiError('Offline', 0, 'network'));

    await expect(sessionActions.logout()).rejects.toThrow('Offline');

    expect(mocks.clearCachedSession).not.toHaveBeenCalled();
    expect(queryClient.setQueryData).not.toHaveBeenCalled();
  });

  it('clears renderer and desktop state after a successful server logout', async () => {
    await sessionActions.logout();

    expect(logout).toBe(mocks.apiLogout);
    expect(mocks.clearCachedSession).toHaveBeenCalledOnce();
    expect(queryClient.setQueryData).toHaveBeenCalledWith(queryKeys.session, null);
  });
});
