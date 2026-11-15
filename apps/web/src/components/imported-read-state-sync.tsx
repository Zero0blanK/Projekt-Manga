'use client';

import { useEffect, useRef } from 'react';
import { useMangaLibrary } from '@/lib/library-store';
import { useCurrentUser } from '@/lib/session-resource';
import { applyPendingImportedChapterStates } from '@/lib/tachiyomi-backup/extras';
import type { Manga } from '@/lib/manga-data';

/**
 * Applies a backup import's read state, saved by chapter number, as soon as a title's
 * chapters exist: whenever the library list loads or refreshes (at start-up, and after a
 * library update has synced chapters). Before, only the title's own page applied it, so an
 * imported title counted every chapter as unread until it was opened.
 *
 * One sweep at a time. A sweep is not abandoned when the list changes under it (marking is
 * idempotent and only reads stored chapters); it runs again afterwards on the newest list.
 */
export function ImportedReadStateSync() {
  const { user, loading: sessionLoading } = useCurrentUser();
  const { manga, loading, refresh } = useMangaLibrary();
  const owner = user?.id ?? 'anonymous';
  const latest = useRef<{ owner: string; manga: readonly Manga[]; refresh: () => unknown }>({
    owner,
    manga,
    refresh,
  });
  latest.current = { owner, manga, refresh };
  const sweep = useRef<{ running: boolean; again: boolean }>({ running: false, again: false });

  useEffect(() => {
    if (sessionLoading || loading || manga.length === 0) return;
    const state = sweep.current;
    if (state.running) {
      state.again = true;
      return;
    }
    state.running = true;
    void (async () => {
      try {
        do {
          state.again = false;
          const { owner: who, manga: list, refresh: reload } = latest.current;
          const marked = await applyPendingImportedChapterStates(who, list).catch(() => 0);
          if (marked > 0) void reload();
        } while (state.again);
      } finally {
        state.running = false;
      }
    })();
  }, [owner, manga, loading, sessionLoading]);

  return null;
}
