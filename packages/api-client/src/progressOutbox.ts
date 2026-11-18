import { ApiError, request } from './client.js';
import type { MangaChapterRecord } from './manga.js';

/**
 * Reading progress kept on this device while the server can't be reached.
 *
 * The desktop app saves progress to its own database first and syncs it later. A browser
 * used to lose it instead: a page turn with no connection failed, and the place was gone.
 * Now a progress or history write that can't reach the server is kept here and sent once
 * it can, and chapter lists read meanwhile show it, so the reader and the title page agree
 * with what was read offline.
 *
 * Only the newest write of each kind per chapter is kept: its page, and separately whether
 * it is read, since reaching the last page marks it read and the next page save must not
 * replace that. Reading time adds up, since the server adds each write's time to its total.
 *
 * Inert until the app installs a store (apps/web/src/lib/progress-outbox.ts), so a server
 * render or another consumer of this package never queues anything.
 */

export interface PendingWrite {
  /** One chapter's progress, or one chapter's history entry. */
  key: string;
  path: string;
  body: Record<string, unknown>;
  /** When it was last written, for sending in order. */
  at: number;
  /** The account it was written by; it is only ever sent for that account. */
  owner: string;
  /** What it says about the chapter, for showing it before the server has it. */
  chapter?: {
    source: string;
    mangaSlug: string;
    sourceChapterKey: string;
    lastPageRead?: number;
    isRead?: boolean;
  };
}

export interface ProgressOutboxStore {
  read(): PendingWrite[];
  write(entries: PendingWrite[]): void;
  /** Who is signed in now ("anonymous" when nobody), or null while that isn't known. */
  owner(): string | null;
}

let store: ProgressOutboxStore | null = null;
const listeners = new Set<() => void>();

export function setProgressOutboxStore(next: ProgressOutboxStore | null): void {
  store = next;
}

/** Called after the outbox changes: something queued, or something sent. */
export function onProgressOutboxChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function changed() {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // A listener must never stop a write.
    }
  }
}

/** A failure that means "couldn't reach the server", not "the server said no". */
export function isUnreachable(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.kind === 'network' || error.kind === 'timeout') return true;
  // A reverse proxy in front of a stopped server answers 502/503/504.
  return error.kind === 'http' && error.status >= 502 && error.status <= 504;
}

export function pendingProgressWrites(): PendingWrite[] {
  return store?.read() ?? [];
}

function save(entry: Omit<PendingWrite, 'owner' | 'at'>): boolean {
  if (!store) return false;
  const owner = store.owner();
  if (owner === null) return false;
  const entries = store.read();
  const prior = entries.find((e) => e.key === entry.key && e.owner === owner);
  const body = { ...entry.body };
  if (prior && typeof prior.body.time_read === 'number') {
    body.time_read = (Number(body.time_read) || 0) + prior.body.time_read;
  }
  const next = entries.filter((e) => !(e.key === entry.key && e.owner === owner));
  next.push({ ...entry, body, owner, at: Date.now() });
  store.write(next);
  changed();
  return true;
}

/** A write for `key` reached the server: an older queued one for it is superseded. */
function superseded(key: string) {
  if (!store) return;
  const owner = store.owner();
  const entries = store.read();
  const next = entries.filter((e) => !(e.key === key && e.owner === owner));
  if (next.length !== entries.length) {
    store.write(next);
    changed();
  }
}

/**
 * Sends a progress or history write, or keeps it here if the server can't be reached.
 * Resolves with `queued` in place of the server's answer when it was kept.
 */
export async function sendOrKeep<T>(
  entry: Omit<PendingWrite, 'owner' | 'at'>,
  queued: T,
): Promise<T> {
  try {
    const result = await request<T>(entry.path, { method: 'POST', body: entry.body });
    superseded(entry.key);
    return result;
  } catch (error) {
    if (isUnreachable(error) && save(entry)) return queued;
    throw error;
  }
}

let flushing: Promise<{ sent: number; remaining: number }> | null = null;

/**
 * Sends what was kept, oldest first, for the account signed in now. Stops at the first
 * write the server still can't be reached for; drops one it refuses outright (a chapter
 * removed meanwhile, say), since resending it would never succeed.
 */
export function flushProgressOutbox(): Promise<{ sent: number; remaining: number }> {
  flushing ??= (async () => {
    let sent = 0;
    try {
      const owner = store?.owner() ?? null;
      if (!store || owner === null) return { sent, remaining: pendingProgressWrites().length };
      const mine = store
        .read()
        .filter((e) => e.owner === owner)
        .sort((a, b) => a.at - b.at);
      for (const entry of mine) {
        try {
          await request(entry.path, { method: 'POST', body: entry.body });
          sent++;
        } catch (error) {
          if (isUnreachable(error)) break;
        }
        // Sent or refused: either way it leaves, unless a newer write replaced it meanwhile.
        const now = store.read();
        store.write(
          now.filter((e) => !(e.key === entry.key && e.owner === owner && e.at === entry.at)),
        );
        changed();
      }
      return { sent, remaining: store.read().filter((e) => e.owner === owner).length };
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}

/**
 * Chapter records with the progress still waiting here applied, so a chapter list read
 * from the server (or a cached copy of it) shows where the reader really is.
 */
export function withPendingProgress(
  records: MangaChapterRecord[],
  mangaSlug: string,
  source?: string,
): MangaChapterRecord[] {
  const owner = store?.owner() ?? null;
  if (!store || owner === null) return records;
  const pending = new Map<string, NonNullable<PendingWrite['chapter']>>();
  for (const entry of store.read().sort((a, b) => a.at - b.at)) {
    const chapter = entry.chapter;
    if (entry.owner !== owner || !chapter || chapter.mangaSlug !== mangaSlug) continue;
    if (source && chapter.source !== source) continue;
    pending.set(chapter.sourceChapterKey, { ...pending.get(chapter.sourceChapterKey), ...chapter });
  }
  if (pending.size === 0) return records;
  return records.map((record) => {
    const chapter = pending.get(record.source_chapter_key);
    if (!chapter) return record;
    return {
      ...record,
      ...(chapter.lastPageRead !== undefined ? { last_page_read: chapter.lastPageRead } : {}),
      ...(chapter.isRead !== undefined ? { is_read: chapter.isRead } : {}),
    };
  });
}
