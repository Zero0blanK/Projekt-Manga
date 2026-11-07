'use client';

import {
  addCategory,
  deleteCategory,
  importCategories,
  setCategoryMembership,
  updateCategory,
  type CategoryWithMembers,
} from '@projekt-manga/api-client';
import {
  getPendingCategoryImport,
  setCategoryBackend,
  setServerCategories,
  clearPendingCategoryImport,
} from '@/lib/app-store';
import { queryClient, queryKeys } from '@/lib/query-client';
import { reportError } from '@/lib/report-error';

/**
 * Keeps the library's categories on the server, one list per account plus one for
 * anonymous use.
 *
 * The store still answers every read, so screens stay synchronous: an edit shows at once,
 * and this sends it. Writes run one at a time so "add, then put a title in it" keeps its
 * order. A failed write puts the store back to what the server says.
 */

/** Category name → server id. Screens work in names; the API works in ids. */
const idsByName = new Map<string, string>();
let queue: Promise<unknown> = Promise.resolve();
let pendingWrites = 0;
let loadedOwner: string | null | undefined;

const reload = () => queryClient.invalidateQueries({ queryKey: queryKeys.categories });

function enqueue(write: () => Promise<unknown>) {
  pendingWrites += 1;
  queue = queue
    .then(write)
    .catch((error: unknown) => {
      reportError(error, "Couldn't save that category change. Try again.");
    })
    .finally(() => {
      pendingWrites -= 1;
      // Whatever the outcome, the server has the last word once the queue is empty.
      if (pendingWrites === 0) void reload();
    });
}

async function idOf(name: string): Promise<string> {
  const known = idsByName.get(name);
  if (known) return known;
  const created = await addCategory(name);
  idsByName.set(name, created.id);
  return created.id;
}

setCategoryBackend({
  add: (name) => enqueue(() => idOf(name)),
  remove: (name) =>
    enqueue(async () => {
      const id = idsByName.get(name);
      if (id) await deleteCategory(id);
      idsByName.delete(name);
    }),
  rename: (name, nextName) =>
    enqueue(async () => {
      const id = await idOf(name);
      await updateCategory(id, nextName);
      idsByName.delete(name);
      idsByName.set(nextName, id);
    }),
  setMember: (name, mangaId, member) =>
    enqueue(async () => setCategoryMembership(await idOf(name), mangaId, member)),
  merge: (categories) =>
    enqueue(() => importCategories(categories.map(({ name, ids }) => ({ name, manga_ids: ids })))),
});

const cacheKey = (owner: string | null) => `category-cache:${owner ?? 'anonymous'}`;

function readCache(owner: string | null): CategoryWithMembers[] | null {
  try {
    const raw = localStorage.getItem(cacheKey(owner));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? (parsed as CategoryWithMembers[]) : null;
  } catch {
    return null;
  }
}

function writeCache(owner: string | null, categories: CategoryWithMembers[]) {
  try {
    localStorage.setItem(cacheKey(owner), JSON.stringify(categories));
  } catch {
    /* A cache: the next load simply fetches. */
  }
}

function show(categories: CategoryWithMembers[]) {
  idsByName.clear();
  for (const { id, name } of categories) idsByName.set(name, id);
  setServerCategories(categories);
}

/** On a change of identity, what this device last saw for it, so the library doesn't lose
 * its categories for a moment, or altogether while the server is out of reach. */
export function showCachedCategories(owner: string | null) {
  if (loadedOwner === owner) return;
  loadedOwner = owner;
  show(readCache(owner) ?? []);
}

/** A fresh answer from the server. Ignored while writes are queued: it may predate them,
 * and one more arrives when they finish. */
export function applyServerCategories(owner: string | null, categories: CategoryWithMembers[]) {
  writeCache(owner, categories);
  if (pendingWrites === 0 && loadedOwner === owner) show(categories);
}

let importing = false;

/**
 * Moves categories an older version kept in this browser onto the server, once, into
 * whichever identity uses the browser first. Kept until the upload succeeds, so a failure
 * only means trying again on the next load.
 */
export async function uploadLocalCategories() {
  const pending = getPendingCategoryImport();
  if (importing || !pending) return;
  importing = true;
  try {
    await importCategories(
      pending.customCategories.map((name) => ({
        name,
        manga_ids: pending.categoryMembers[name] ?? [],
      })),
    );
    clearPendingCategoryImport();
    await reload();
  } catch {
    /* Silent: the categories are safe in the browser and this runs again on the next load. */
  } finally {
    importing = false;
  }
}
