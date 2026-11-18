'use client';

import type { QueryClient } from '@tanstack/react-query';
import { hasLocalDataBridge, type LibraryState, type PublicUser } from '@projekt-manga/api-client';
import type { Manga } from './manga-data';
import { queryKeys } from './query-client';

/**
 * A copy of the library on this device, so it opens at once and without a connection.
 *
 * The library comes from the server, which on a slow connection takes seconds (a minute
 * or more on 2G) and with no connection never comes. This keeps the last library and its
 * shelf state in IndexedDB and shows it while the server is asked again; the fresh copy
 * replaces it when it arrives. With the server unreachable, it stays, so the library can
 * still be browsed (sources, of course, still need the internet).
 *
 * One copy per account: it is saved under the signed-in account and only shown to that
 * account, and signing in, out or switching accounts deletes it, so a shared browser never
 * shows one person's library to another.
 *
 * Not on desktop, which already reads the library from its own local database.
 */

const DB_NAME = 'projekt-manga-offline';
const STORE = 'library';
/** The account the saved copy belongs to, readable before the session request returns. */
const OWNER_KEY = 'projekt-manga:offline-owner';
const ANONYMOUS = 'anonymous';

interface Snapshot {
  owner: string;
  savedAt: number;
  library: Manga[];
  libraryState: LibraryState[];
}

function available(): boolean {
  return typeof indexedDB !== 'undefined' && !hasLocalDataBridge();
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

/** The account the saved library belongs to: the last one the server named here. */
export function storedOwner(): string | null {
  try {
    return window.localStorage.getItem(OWNER_KEY);
  } catch {
    return null;
  }
}

function setStoredOwner(owner: string | null): void {
  try {
    if (owner === null) window.localStorage.removeItem(OWNER_KEY);
    else window.localStorage.setItem(OWNER_KEY, owner);
  } catch {
    // Storage unavailable: nothing is saved either, so nothing can be shown to the wrong account.
  }
}

export const ownerOf = (user: PublicUser | null | undefined) => user?.id ?? ANONYMOUS;

/** Whether the library on screen is part of a first load still arriving page by page. */
let libraryFilling = false;
export const isLibraryFilling = () => libraryFilling;
export const setLibraryFilling = (filling: boolean) => {
  libraryFilling = filling;
};

/** Whether the library on screen is the saved copy rather than the server's answer. */
let showingSaved = false;
export const isShowingSavedLibrary = () => showingSaved;
/** The server answered: what is on screen is no longer the saved copy. */
export const noteFreshLibrary = () => {
  showingSaved = false;
};

/**
 * Puts the saved library on screen, if there is one for the account last signed in here
 * and nothing newer is showing yet. The query still fetches; its answer replaces this.
 */
export async function restoreSavedLibrary(client: QueryClient): Promise<void> {
  if (!available()) return;
  const owner = storedOwner();
  if (!owner) return;
  let snapshot: Snapshot | undefined;
  try {
    snapshot = await withStore<Snapshot | undefined>('readonly', (store) => store.get(owner));
  } catch {
    return;
  }
  if (!snapshot || snapshot.owner !== owner || storedOwner() !== owner) return;
  const current = client.getQueryData<Manga[]>(queryKeys.mangaLibrary);
  // A first load's opening pages (library-store.ts) give way to the whole saved library.
  if (current && current.length > 0 && !libraryFilling) return;
  showingSaved = true;
  // `updatedAt` in the past keeps it stale, so the server is still asked.
  client.setQueryData(queryKeys.mangaLibrary, snapshot.library, { updatedAt: snapshot.savedAt });
  if (!client.getQueryData(queryKeys.libraryState)) {
    client.setQueryData(queryKeys.libraryState, snapshot.libraryState, {
      updatedAt: snapshot.savedAt,
    });
  }
}

/** Saves what the server last said, under the account it said it for. */
export async function saveLibrary(client: QueryClient): Promise<void> {
  if (!available()) return;
  // Only once the server has said whose library this is.
  const session = client.getQueryState<PublicUser | null>(queryKeys.session);
  if (session?.status !== 'success') return;
  const library = client.getQueryState<Manga[]>(queryKeys.mangaLibrary);
  if (library?.status !== 'success' || !library.data || library.fetchStatus === 'fetching') return;
  const owner = ownerOf(session.data);
  const snapshot: Snapshot = {
    owner,
    savedAt: library.dataUpdatedAt,
    library: library.data,
    libraryState: client.getQueryData<LibraryState[]>(queryKeys.libraryState) ?? [],
  };
  try {
    await withStore('readwrite', (store) => store.put(snapshot, owner));
    setStoredOwner(owner);
  } catch {
    // Quota or privacy mode: only the offline copy is lost.
  }
}

/**
 * The server said who is signed in. If that isn't who the saved copy belongs to (a session
 * that ended, say), the copy is deleted, and taken off screen if it was showing.
 */
export function checkSavedLibraryOwner(client: QueryClient, user: PublicUser | null): void {
  const owner = storedOwner();
  if (!owner || owner === ownerOf(user)) return;
  const wasShowing = showingSaved;
  void forgetSavedLibraries();
  if (wasShowing) {
    client.setQueryData(queryKeys.mangaLibrary, []);
    client.setQueryData(queryKeys.libraryState, []);
    void client.invalidateQueries({ queryKey: queryKeys.mangaLibrary });
    void client.invalidateQueries({ queryKey: queryKeys.libraryState });
  }
}

/** Deletes every saved library: the account changed (signed in, out, or switched). */
export async function forgetSavedLibraries(): Promise<void> {
  showingSaved = false;
  setStoredOwner(null);
  if (typeof indexedDB === 'undefined') return;
  try {
    await withStore('readwrite', (store) => store.clear());
  } catch {
    // Nothing saved, or storage unavailable.
  }
}
