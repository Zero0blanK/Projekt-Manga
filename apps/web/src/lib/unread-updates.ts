'use client';

import { useSetting } from '@/lib/app-store';
import { useLibraryState } from '@/lib/library-store';
import { groupChaptersByManga, useRecentChapters } from '@/lib/notifications-store';

/**
 * The titles whose new chapters (found by a library update) the reader hasn't looked at
 * yet, by manga id: what the nav bell's dot and the desktop taskbar badge count. Empty
 * while new-chapter alerts are off.
 */
export function useUnreadUpdateTitles(): string[] {
  const { chapters } = useRecentChapters();
  const { readNotifications } = useLibraryState();
  const alertsEnabled = useSetting('notifyNewChapter', true) as boolean;
  if (!alertsEnabled) return [];
  return groupChaptersByManga(chapters)
    .filter((update) => !readNotifications.includes(update.mangaId))
    .map((update) => update.mangaId);
}
