'use client';

import {
  ApiError,
  getCurrentUser,
  register as apiRegister,
  login as apiLogin,
  logout as apiLogout,
  deleteAccount as apiDeleteAccount,
  signOutOtherDevices as apiSignOutOtherDevices,
  hasLocalDataBridge,
  localInvoke,
  type PublicUser,
  type RegisterPayload,
  type LoginPayload,
} from '@projekt-manga/api-client';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { queryClient, queryKeys } from './query-client';
import { reportError } from './report-error';
import { cancelLibraryUpdate } from './run-library-update';

const EMPTY_USER: PublicUser | null = null;

/**
 * The signed-in user, or null when nobody is. Reads through the same query cache as
 * library-store so `sessionActions` below — plain functions called from form handlers,
 * not hooks — can write the result straight into it after a login or logout.
 *
 * The hydration guard matches library-store's: the server renders with no session data
 * (this query only ever runs in the browser), so the first client render has to report
 * null even when the cache is already warm.
 */
export function useCurrentUser() {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  const { data, isPending, error } = useQuery({
    queryKey: queryKeys.session,
    queryFn: async ({ signal }) => (await getCurrentUser(signal)).user,
    // "Who am I" is cheap and load-bearing for whether account-only UI renders at all;
    // an unnecessary refetch is far less costly than showing a stale signed-out state.
    staleTime: 30_000,
  });

  return {
    user: hydrated ? (data ?? EMPTY_USER) : EMPTY_USER,
    loading: !hydrated || isPending,
    error,
  };
}

function setSessionUser(user: PublicUser | null) {
  cancelLibraryUpdate();
  queryClient.setQueryData(queryKeys.session, user);
  queryClient.setQueryData(queryKeys.mangaLibrary, []);
  queryClient.setQueryData(queryKeys.libraryState, []);
  void queryClient.invalidateQueries({ queryKey: queryKeys.mangaLibrary });
  void queryClient.invalidateQueries({ queryKey: queryKeys.libraryState });
}

async function seedDesktopAccount(): Promise<void> {
  if (!hasLocalDataBridge()) return;
  await localInvoke('sync', 'seed');
  await queryClient.invalidateQueries({ queryKey: queryKeys.mangaLibrary });
  await queryClient.invalidateQueries({ queryKey: queryKeys.libraryState });
}

async function activateDesktopAccount(user: PublicUser): Promise<void> {
  const bridge = desktopAuthBridge();
  if (!bridge?.syncCachedSession) return;
  try {
    await bridge.syncCachedSession({ user_id: user.id, email: user.email });
    await seedDesktopAccount();
  } catch (error) {
    reportError(
      error,
      'Signed in, but desktop local data could not load. Retry after reconnecting.',
    );
  }
}

/** Optional desktop auth-cache bridge (same probe pattern as open-folder-button.tsx's
 * desktopBridge()). The session cookie itself is httpOnly, so this never hands the
 * bridge the raw token — only {user_id, email}; the main process reads the actual
 * session id straight out of Electron's own cookie store (see main/ipc.ts's
 * authSyncCachedSession handler). Without this call, the desktop app's local-first sync
 * runner (main/sync.ts) has no way to learn a login that happened in this renderer ever
 * occurred, and silently never syncs. */
type DesktopAuthBridge = {
  syncCachedSession?: (info: { user_id: string; email: string }) => Promise<unknown>;
  clearCachedSession?: () => Promise<unknown>;
};
function desktopAuthBridge(): DesktopAuthBridge | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { desktop?: { auth?: DesktopAuthBridge } }).desktop?.auth ?? null;
}

export const sessionActions = {
  async register(payload: RegisterPayload) {
    const { user } = await apiRegister(payload);
    setSessionUser(user);
    void activateDesktopAccount(user);
    return user;
  },
  async login(payload: LoginPayload) {
    const { user } = await apiLogin(payload);
    setSessionUser(user);
    void activateDesktopAccount(user);
    return user;
  },
  async logout() {
    try {
      await apiLogout();
    } catch (error) {
      // An expired or revoked session is already signed out on the server. Clear local
      // renderer/desktop identity so the user is not trapped in a failing logout loop.
      if (!(error instanceof ApiError && error.status === 401)) throw error;
    }
    await desktopAuthBridge()
      ?.clearCachedSession?.()
      .catch((error: unknown) => reportError(error, 'Desktop session could not be cleared.'));
    setSessionUser(null);
  },
  async deleteAccount(password: string) {
    await apiDeleteAccount(password);
    await desktopAuthBridge()
      ?.clearCachedSession?.()
      .catch((error: unknown) => reportError(error, 'Desktop session could not be cleared.'));
    setSessionUser(null);
  },
  async signOutOtherDevices() {
    const { revoked } = await apiSignOutOtherDevices();
    return revoked;
  },
};
