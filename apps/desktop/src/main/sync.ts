/**
 * Desktop's half of the delta-sync protocol — pushes local changes made since
 * the last successful push, then pulls the server's already-merged state and applies it
 * to the local DB (see local-store.ts's applyPulledChanges: the server is the merge
 * authority, this side never re-resolves a conflict itself).
 *
 * Runs in the main process, which has no browser cookie jar — the session cookie header
 * is built by hand from the cached session (auth-cache.ts), the same offline identity
 * that lets this device know which account owns its local DB in the first place. The
 * renderer populates that cache via DESKTOP_CHANNELS.authSyncCachedSession right after a
 * successful login (see ipc.ts) — this module only ever reads it. The renderer invokes
 * runSync() through IPC for scheduled and user-requested synchronization.
 */
import { session as electronSession } from 'electron';
import { localStore } from './db/local-store';
import { getCachedSession, clearCachedSession } from './auth-cache';
import { SESSION_COOKIE_NAME, resolveWebUrl } from '../shared/config';
import { sessionCookieOrigins } from './session-cookie-origins';
import { requireSecureAccountTransport } from './secure-transport';

export interface DomainPushResult {
  applied: number;
  /** Ids of rows that failed to apply — one bad row no longer aborts the rest of the
   * push (see sync.service.ts on the server), so this is how a caller learns something
   * didn't fully land. */
  failed: string[];
}

export interface PushCounts {
  library: DomainPushResult;
  manga_state: DomainPushResult;
  chapter_state: DomainPushResult;
  manga_category: DomainPushResult;
  history: DomainPushResult;
}

export interface PullCounts {
  library: number;
  manga_state: number;
  chapter_state: number;
  manga_category: number;
  history: number;
}

export interface SyncResult {
  pushed: PushCounts | null;
  pulled: PullCounts;
}

interface ResponseEnvelope<T> {
  success: boolean;
  message?: string;
  data?: T;
}

class SyncHttpError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'SyncHttpError';
    this.status = status;
  }
}

async function callJson<T>(
  url: string,
  headers: Record<string, string>,
  init?: RequestInit,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { ...headers, ...init?.headers },
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000),
    redirect: 'error',
  });
  const envelope = (await res.json().catch(() => null)) as ResponseEnvelope<T> | null;
  if (!res.ok || !envelope?.success) {
    throw new SyncHttpError(
      envelope?.message || `Sync request failed with status ${res.status}`,
      res.status,
    );
  }
  return envelope.data as T;
}

/** Ceiling on pages fetched in one sync run — see the pull loop below. */
const MAX_PULL_PAGES = 50;

let activeSync: {
  sessionId: string;
  controller: AbortController;
  promise: Promise<SyncResult | null>;
} | null = null;

/** A single Electron main process can serve several renderer windows. Share one run and
 * abort it before the cached session changes, so two windows cannot race the same cursor. */
export function cancelActiveSync(): void {
  activeSync?.controller.abort();
}

export function runSync(apiBaseUrl: string): Promise<SyncResult | null> {
  const session = getCachedSession();
  if (!session) return Promise.resolve(null);
  if (activeSync?.sessionId === session.session_id) return activeSync.promise;
  cancelActiveSync();

  const controller = new AbortController();
  const promise = runSyncOnce(apiBaseUrl, false, controller.signal);
  activeSync = { sessionId: session.session_id, controller, promise };
  void promise
    .finally(() => {
      if (activeSync?.promise === promise) activeSync = null;
    })
    .catch(() => {
      // The original promise carries the rejection to each renderer caller.
    });
  return promise;
}

/** Returns null (rather than throwing) when no account is cached locally — "not logged
 * in" is an expected, common state, not a sync failure. */
async function runSyncOnce(
  apiBaseUrl: string,
  resetRetried = false,
  signal: AbortSignal,
): Promise<SyncResult | null> {
  const session = getCachedSession();
  if (!session) {
    return null;
  }

  requireSecureAccountTransport(apiBaseUrl);
  const headers = { Cookie: `${SESSION_COOKIE_NAME}=${session.session_id}` };
  const assertSameAccount = () => {
    if (signal?.aborted) throw new Error('Sync cancelled because the account changed');
    const current = getCachedSession();
    if (current?.user_id !== session.user_id || current.session_id !== session.session_id) {
      throw new Error('Account changed during sync; retry for the current account');
    }
  };

  try {
    assertSameAccount();
    const serverGeneration = await callJson<{ generation: number }>(
      `${apiBaseUrl}/sync/generation`,
      headers,
      undefined,
      signal,
    );
    assertSameAccount();
    if (!Number.isSafeInteger(serverGeneration.generation) || serverGeneration.generation < 0)
      throw new Error('Invalid server sync generation');
    const localGeneration = localStore.getSyncGeneration();
    if (localGeneration !== null && localGeneration > serverGeneration.generation)
      throw new Error('Server sync generation is older than this device; check server data');
    if (serverGeneration.generation > (localGeneration ?? 0)) {
      await localStore.reconcileRestoreFromServer(apiBaseUrl);
      assertSameAccount();
    } else if (localGeneration === null) {
      localStore.setSyncGeneration(serverGeneration.generation);
    }
    const pending = localStore.getPendingChanges();
    const hasPending = Object.values(pending).some((rows) => rows.length > 0);

    let pushed: PushCounts | null = null;
    if (hasPending) {
      // Captured before the request, on the same principle as the server's own pull
      // cursor: a local write that lands between this timestamp and the request actually
      // completing is still guaranteed to be picked up by the *next* push (its updated_at
      // will be >= this cursor), so nothing is silently dropped.
      const pushStartedAt = new Date().toISOString();
      pushed = await callJson<PushCounts>(
        `${apiBaseUrl}/sync/push`,
        headers,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...pending, generation: serverGeneration.generation }),
        },
        signal,
      );
      assertSameAccount();
      // A 200 response can still contain row-level failures. Keep the old cursor so
      // those rows are retried; successful rows are idempotent on the server.
      if (Object.values(pushed).every((domain) => domain.failed.length === 0)) {
        localStore.setSyncCursor({ last_pushed_at: pushStartedAt });
      } else {
        // Pull would overwrite a rejected local row with the server's older copy.
        // Retry the push first; successful rows are safe to replay.
        return {
          pushed,
          pulled: { library: 0, manga_state: 0, chapter_state: 0, manga_category: 0, history: 0 },
        };
      }
    }

    /**
     * The server caps each domain per response and reports `has_more`, so one pull is no
     * longer necessarily the whole delta — this loops until the server says it is caught
     * up. Without the loop the cursor would advance past rows that were never sent, and the delta query only looks
     * forward, so they would be lost permanently.
     *
     * Bounded so a server that always reports `has_more` (a bug, or a device generating
     * changes faster than it can drain them) cannot spin here forever; whatever is left
     * is picked up by the next scheduled sync.
     */
    const totals: PullCounts = {
      library: 0,
      manga_state: 0,
      chapter_state: 0,
      manga_category: 0,
      history: 0,
    };

    for (let page = 0; page < MAX_PULL_PAGES; page++) {
      const pullCursor = localStore.getSyncCursor().last_pulled_at;
      const pullUrl = pullCursor
        ? `${apiBaseUrl}/sync/pull?since=${encodeURIComponent(pullCursor)}`
        : `${apiBaseUrl}/sync/pull`;
      const pulled = await callJson<{
        server_time: string;
        /** Absent on a server predating paged pull — fall back to server_time. */
        next_since?: string;
        has_more?: boolean;
        library: unknown[];
        manga_state: unknown[];
        chapter_state: unknown[];
        manga_category: unknown[];
        history: unknown[];
        categories: unknown[];
      }>(pullUrl, headers, undefined, signal);
      assertSameAccount();

      const { minSkippedUpdatedAt } = localStore.applyPulledChanges(
        pulled as unknown as Parameters<typeof localStore.applyPulledChanges>[0],
      );

      totals.library += pulled.library.length;
      totals.manga_state += pulled.manga_state.length;
      totals.chapter_state += pulled.chapter_state.length;
      totals.manga_category += pulled.manga_category.length;
      totals.history += pulled.history.length;

      // Never advance past a row this pass couldn't apply (its manga/chapter isn't cached
      // locally yet) — otherwise the server's `updated_at > cursor` delta query would drop
      // it from every future pull for good. Once the missing catalog entry does get
      // cached (e.g. after a seed/re-seed), the next pull will pick this row up again.
      const serverCursor = pulled.next_since ?? pulled.server_time;
      const nextCursor =
        minSkippedUpdatedAt && minSkippedUpdatedAt < serverCursor
          ? minSkippedUpdatedAt
          : serverCursor;
      localStore.setSyncCursor({ last_pulled_at: nextCursor });

      if (!pulled.has_more) {
        break;
      }

      // A skipped row pins the cursor behind the page the server just sent, so asking
      // again would return the same page forever. Stop and let the next sync retry, once
      // the missing catalog rows have had a chance to arrive.
      if (minSkippedUpdatedAt && minSkippedUpdatedAt < serverCursor) {
        break;
      }
    }

    return { pushed, pulled: totals };
  } catch (error) {
    if (
      error instanceof SyncHttpError &&
      error.status === 409 &&
      error.message === 'Sync reset required after a library restore' &&
      !resetRetried
    ) {
      assertSameAccount();
      await localStore.reconcileRestoreFromServer(apiBaseUrl);
      return runSyncOnce(apiBaseUrl, true, signal);
    }
    if (
      error instanceof SyncHttpError &&
      error.status === 401 &&
      getCachedSession()?.session_id === session.session_id
    ) {
      // The cached session is no longer valid server-side (expired, or revoked via
      // "sign out other devices") — keeping it around would just fail the same way on
      // every future sync attempt with no way for the user to recover short of manually
      // deleting the cache file. Clearing it means the next sync attempt cleanly reports
      // "not logged in" instead, and the next successful sign-in can populate a fresh one.
      cancelActiveSync();
      clearCachedSession();
      // The renderer's cookie lives on the web app's origin as often as the API's, so
      // clear it everywhere ipc.ts's rendererSessionCookie would look for it.
      for (const origin of sessionCookieOrigins(apiBaseUrl, resolveWebUrl())) {
        await electronSession.defaultSession.cookies.remove(origin, SESSION_COOKIE_NAME);
      }
    }
    throw error;
  }
}
