'use client';

import {
  flushProgressOutbox,
  hasLocalDataBridge,
  onProgressOutboxChange,
  pendingProgressWrites,
  setProgressOutboxStore,
  type PendingWrite,
  type PublicUser,
} from '@projekt-manga/api-client';
import { queryClient, queryKeys } from './query-client';
import { ownerOf, storedOwner } from './offline-library';

/**
 * Where reading progress waits while the server can't be reached, in this browser
 * (see packages/api-client/src/progressOutbox.ts).
 *
 * localStorage rather than IndexedDB: writing it is synchronous, so progress saved as a
 * tab closes is kept even if the page is gone a moment later. It holds a few hundred bytes
 * per chapter read, newest only.
 */

const STORAGE_KEY = 'projekt-manga:progress-outbox';
/** How often a waiting write is retried while the app is open. */
const RETRY_MS = 30_000;

function read(): PendingWrite[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as PendingWrite[]) : [];
  } catch {
    return [];
  }
}

function write(entries: PendingWrite[]): void {
  try {
    if (entries.length === 0) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Storage full or blocked: the write fails as it did before, and says so.
  }
}

/**
 * Whose progress this is. The server says so once it has answered; offline it can't, and
 * the account the saved library belongs to (the last one it named here) stands in. With
 * neither, nothing is kept, so a write is never filed under the wrong account.
 */
function owner(): string | null {
  const session = queryClient.getQueryState<PublicUser | null>(queryKeys.session);
  if (session?.status === 'success') return ownerOf(session.data);
  return storedOwner();
}

let installed = false;

/** Installs the outbox and keeps sending what waits in it. Browser only. */
export function installProgressOutbox(): () => void {
  if (installed || typeof window === 'undefined' || hasLocalDataBridge()) return () => {};
  installed = true;
  setProgressOutboxStore({ read, write, owner });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = async () => {
    clearTimeout(timer);
    timer = undefined;
    if (pendingProgressWrites().length === 0) return;
    const { sent, remaining } = await flushProgressOutbox();
    if (sent > 0) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.mangaLibrary });
      void queryClient.invalidateQueries({ queryKey: queryKeys.libraryState });
      void queryClient.invalidateQueries({ queryKey: queryKeys.history });
    }
    if (remaining > 0) timer = setTimeout(() => void flush(), RETRY_MS);
  };

  const onOnline = () => void flush();
  window.addEventListener('online', onOnline);
  // The server answering again (connection-banner.tsx checks it) is the surest sign.
  const unsubscribeCache = queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || event.action.type !== 'success') return;
    const [key] = event.query.queryKey;
    if (key === 'connection-health' || key === queryKeys.session[0]) void flush();
  });
  // Something was just kept: try again later rather than straight away (it just failed).
  const unsubscribeOutbox = onProgressOutboxChange(() => {
    if (timer === undefined && pendingProgressWrites().length > 0) {
      timer = setTimeout(() => void flush(), RETRY_MS);
    }
  });
  void flush();

  return () => {
    installed = false;
    clearTimeout(timer);
    window.removeEventListener('online', onOnline);
    unsubscribeCache();
    unsubscribeOutbox();
    setProgressOutboxStore(null);
  };
}

/** Whether progress read offline is still waiting to reach the server. */
export const hasPendingProgress = () => pendingProgressWrites().length > 0;
