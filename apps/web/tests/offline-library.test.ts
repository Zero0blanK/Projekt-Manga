import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';

const bridge = vi.hoisted(() => ({ local: false }));
vi.mock('@projekt-manga/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@projekt-manga/api-client')>()),
  hasLocalDataBridge: () => bridge.local,
}));

import {
  checkSavedLibraryOwner,
  forgetSavedLibraries,
  isShowingSavedLibrary,
  noteFreshLibrary,
  restoreSavedLibrary,
  saveLibrary,
  setLibraryFilling,
} from '@/lib/offline-library';
import { queryKeys } from '@/lib/query-client';

/** Just enough IndexedDB for one object store: get, put and clear. */
function installFakeIndexedDb() {
  const rows = new Map<string, unknown>();
  const request = <T>(run: () => T) => {
    const req: { result?: T; error?: unknown; onsuccess?: () => void; onerror?: () => void } = {};
    queueMicrotask(() => {
      req.result = run();
      req.onsuccess?.();
    });
    return req;
  };
  const store = {
    get: (key: string) => request(() => rows.get(key)),
    put: (value: unknown, key: string) => request(() => void rows.set(key, value)),
    clear: () => request(() => rows.clear()),
  };
  const db = { transaction: () => ({ objectStore: () => store }), close: () => {} };
  vi.stubGlobal('indexedDB', {
    open: () => {
      const req: { result?: unknown; onsuccess?: () => void; onupgradeneeded?: () => void } = {};
      queueMicrotask(() => {
        req.result = { ...db, createObjectStore: () => store };
        req.onsuccess?.();
      });
      return req;
    },
  });
  return rows;
}

const title = (id: string) => ({ id, title: `Title ${id}` });
const user = (id: string) => ({ id, email: `${id}@example.test` });

function serverAnswered(client: QueryClient, who: { id: string } | null, library: unknown[]) {
  client.setQueryData(queryKeys.session, who);
  client.setQueryData(queryKeys.mangaLibrary, library);
  client.setQueryData(queryKeys.libraryState, [{ manga_id: 'a', shelf: 'reading' }]);
}

let rows: Map<string, unknown>;

beforeEach(() => {
  bridge.local = false;
  window.localStorage.clear();
  rows = installFakeIndexedDb();
  noteFreshLibrary();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the on-device copy of the library', () => {
  it('is saved under the signed-in account and shown on the next start', async () => {
    const before = new QueryClient();
    serverAnswered(before, user('u1'), [title('a'), title('b')]);
    await saveLibrary(before);
    expect(rows.has('u1')).toBe(true);

    const next = new QueryClient();
    await restoreSavedLibrary(next);
    expect(next.getQueryData(queryKeys.mangaLibrary)).toEqual([title('a'), title('b')]);
    expect(isShowingSavedLibrary()).toBe(true);
    // Dated when it was saved, not now, so it counts as stale and the server is still asked.
    expect(next.getQueryState(queryKeys.mangaLibrary)?.dataUpdatedAt).toBe(
      before.getQueryState(queryKeys.mangaLibrary)?.dataUpdatedAt,
    );
  });

  it("isn't saved before the server has said whose library it is", async () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.mangaLibrary, [title('a')]);
    await saveLibrary(client);
    expect(rows.size).toBe(0);
  });

  it("doesn't replace a library that is already showing", async () => {
    const before = new QueryClient();
    serverAnswered(before, user('u1'), [title('old')]);
    await saveLibrary(before);

    const next = new QueryClient();
    next.setQueryData(queryKeys.mangaLibrary, [title('fresh')]);
    await restoreSavedLibrary(next);
    expect(next.getQueryData(queryKeys.mangaLibrary)).toEqual([title('fresh')]);
  });

  it('replaces the first page of a first load that is still arriving', async () => {
    const before = new QueryClient();
    serverAnswered(before, user('u1'), [title('a'), title('b'), title('c')]);
    await saveLibrary(before);

    const next = new QueryClient();
    setLibraryFilling(true);
    next.setQueryData(queryKeys.mangaLibrary, [title('a')]);
    await restoreSavedLibrary(next);
    setLibraryFilling(false);
    expect(next.getQueryData(queryKeys.mangaLibrary)).toEqual([title('a'), title('b'), title('c')]);
  });

  it('is deleted, and taken off screen, when the server says another account is signed in', async () => {
    const before = new QueryClient();
    serverAnswered(before, user('u1'), [title('a')]);
    await saveLibrary(before);
    const next = new QueryClient();
    await restoreSavedLibrary(next);

    checkSavedLibraryOwner(next, user('u2'));
    await vi.waitFor(() => expect(rows.size).toBe(0));
    expect(next.getQueryData(queryKeys.mangaLibrary)).toEqual([]);

    const later = new QueryClient();
    await restoreSavedLibrary(later);
    expect(later.getQueryData(queryKeys.mangaLibrary)).toBeUndefined();
  });

  it('is deleted when the account changes', async () => {
    const before = new QueryClient();
    serverAnswered(before, null, [title('a')]);
    await saveLibrary(before);
    expect(rows.has('anonymous')).toBe(true);

    await forgetSavedLibraries();
    const next = new QueryClient();
    await restoreSavedLibrary(next);
    expect(next.getQueryData(queryKeys.mangaLibrary)).toBeUndefined();
  });

  it('is not used on desktop, which has its own local database', async () => {
    bridge.local = true;
    const client = new QueryClient();
    serverAnswered(client, user('u1'), [title('a')]);
    await saveLibrary(client);
    expect(rows.size).toBe(0);
  });
});
