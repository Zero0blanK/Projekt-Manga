'use client';

import { useLatest } from '@/lib/use-latest';
import { useEffect, useRef, useState } from 'react';

const EMPTY: ReadonlySet<string> = new Set();
const KEY_PREFIX = 'projekt-manga:seen-chapters:';

function storageKey(owner: string, mangaId: string) {
  return `${KEY_PREFIX}${owner}:${mangaId}`;
}

export function readSeenChapters(owner: string, mangaId: string): Set<string> | null {
  try {
    const raw = window.localStorage.getItem(storageKey(owner, mangaId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? new Set(parsed.filter((id): id is string => typeof id === 'string'))
      : null;
  } catch {
    return null;
  }
}

export function writeSeenChapters(owner: string, mangaId: string, ids: Iterable<string>) {
  try {
    window.localStorage.setItem(storageKey(owner, mangaId), JSON.stringify([...ids]));
  } catch {
    // Private mode or a full quota: the "new" markers are a convenience, not state.
  }
}

/**
 * Chapters that appeared since this person last opened the title. The set seen on the
 * previous visit is captured once when the list first loads, so the markers stay put for
 * the whole visit (and chapters found by a re-check during it are marked too); the current
 * list is saved straight away, so the next visit only marks what arrives after this one.
 * A first visit marks nothing: without an earlier snapshot every chapter would be "new".
 */
export function useNewSinceLastVisit(
  owner: string,
  mangaId: string,
  chapterIds: string[],
  ready: boolean,
): ReadonlySet<string> {
  const previous = useRef<{ key: string; seen: Set<string> | null } | null>(null);
  const [fresh, setFresh] = useState<{ key: string; ids: Set<string> }>(() => ({
    key: '',
    ids: new Set(),
  }));
  const key = `${owner}:${mangaId}`;
  // A new array every render: idsKey says when its contents changed.
  const idsKey = chapterIds.join('\n');
  const ids = useLatest(chapterIds);

  useEffect(() => {
    const chapterIds = ids.current;
    if (!ready || chapterIds.length === 0) return;
    if (previous.current?.key !== key) {
      previous.current = { key, seen: readSeenChapters(owner, mangaId) };
    }
    const seen = previous.current.seen;
    setFresh({ key, ids: seen ? new Set(chapterIds.filter((id) => !seen.has(id))) : new Set() });
    writeSeenChapters(owner, mangaId, chapterIds);
  }, [ready, key, idsKey, ids, owner, mangaId]);

  return fresh.key === key ? fresh.ids : EMPTY;
}
