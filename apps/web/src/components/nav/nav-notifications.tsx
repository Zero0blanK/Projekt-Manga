'use client';

import { useState } from 'react';
import Link from 'next/link';
import { buildImageProxyUrl } from '@projekt-manga/api-client';
import { formatRelative } from '@/lib/manga-data';
import { Cover } from '@/components/cover';
import { useLibraryState, libraryActions, applyLibraryAction } from '@/lib/library-store';
import { useRecentChapters, groupChaptersByManga } from '@/lib/notifications-store';
import { useSetting } from '@/lib/app-store';
import { Bell, BellOff, ChevronDown } from 'lucide-react';

/** Titles listed in the dropdown before it defers to the full page. */
const PREVIEW_LIMIT = 5;

function UpdateRow({
  update,
  unread,
  onNavigate,
}: {
  update: ReturnType<typeof groupChaptersByManga>[number];
  unread: boolean;
  onNavigate: () => void;
}) {
  const [open, setOpen] = useState(false);
  const newest = update.chapters[0];
  const multiple = update.chapters.length > 1;

  return (
    <li className="border-b border-border/40 last:border-0">
      <div className="flex items-center gap-3 px-3 py-2 transition hover:bg-accent">
        <Link
          href={`/manga/${update.mangaId}`}
          onClick={onNavigate}
          className="flex min-w-0 flex-1 items-center gap-3"
        >
          <span className="relative shrink-0">
            <Cover
              mangaId={update.mangaId}
              src={update.thumbnailUrl ? buildImageProxyUrl(update.thumbnailUrl) : null}
              alt=""
              className="h-9 w-7"
            />
            {unread && (
              <span className="absolute -left-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-primary" />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-medium text-foreground">
              {update.title}
            </span>
            <span className="block text-[10px] text-muted-foreground">
              {multiple
                ? `${update.chapters.length} new chapters`
                : `Chapter ${newest.chapter_number}`}
              {update.fetchedAt ? ` · ${formatRelative(update.fetchedAt)}` : ''}
            </span>
          </span>
        </Link>
        {multiple && (
          <button
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={`${open ? 'Hide' : 'Show'} chapters for ${update.title}`}
            className="shrink-0 rounded-md p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground"
          >
            <ChevronDown className={`h-3.5 w-3.5 transition ${open ? 'rotate-180' : ''}`} />
          </button>
        )}
      </div>

      {multiple && open && (
        <ul className="border-t border-border/40 bg-background/40 py-1">
          {update.chapters.map((chapter) => (
            <li key={chapter.id}>
              <Link
                href={`/reader/${update.mangaId}?ch=${chapter.chapter_number}`}
                onClick={onNavigate}
                className="block truncate px-3 py-1.5 pl-13 text-[11px] text-muted-foreground transition hover:bg-accent hover:text-foreground"
              >
                Chapter {chapter.chapter_number}
                {chapter.name ? ` · ${chapter.name}` : ''}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function NavNotifications({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // Chapters the update check actually pulled in (`fetched_at` is only set by the source
  // update flow), from the shared store — it polls and refreshes on library updates, so
  // the dot appears without the page being reloaded.
  const { chapters } = useRecentChapters();
  const { readNotifications } = useLibraryState();
  const alertsEnabled = useSetting('notifyNewChapter', true) as boolean;

  const updates = groupChaptersByManga(chapters);
  const unreadMangaIds = alertsEnabled
    ? updates.filter((u) => !readNotifications.includes(u.mangaId)).map((u) => u.mangaId)
    : [];

  return (
    <div className="relative">
      <button
        aria-label={
          unreadMangaIds.length > 0
            ? `Notifications, ${unreadMangaIds.length} unread`
            : 'Notifications'
        }
        aria-expanded={open}
        aria-controls="nav-notifications-panel"
        onClick={() => {
          const next = !open;
          onOpenChange(next);
          if (next && unreadMangaIds.length > 0) {
            applyLibraryAction(
              libraryActions.markAllNotificationsRead(unreadMangaIds),
              "Couldn't mark every update as read — try again.",
            );
          }
        }}
        className={`relative grid h-11 w-11 shrink-0 place-items-center rounded-full transition focus-visible:outline-2 focus-visible:outline-primary ${
          open
            ? 'bg-accent text-foreground'
            : 'text-muted-foreground hover:bg-accent hover:text-foreground'
        }`}
      >
        {alertsEnabled ? <Bell size={20} /> : <BellOff size={20} />}
        {unreadMangaIds.length > 0 && (
          <span className="absolute right-2.5 top-2.5 h-1.5 w-1.5 rounded-full bg-primary" />
        )}
      </button>

      {open && (
        <div
          id="nav-notifications-panel"
          className="absolute right-0 top-[52px] w-72 overflow-hidden rounded-2xl border border-border/70 bg-popover/95 shadow-lg shadow-black/40 backdrop-blur-xl"
        >
          <div className="border-b border-border/60 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            New chapters
          </div>
          {!alertsEnabled ? (
            <div className="px-4 py-5 text-center text-xs text-muted-foreground">
              New chapter alerts are off — turn them back on in Settings › Notifications.
            </div>
          ) : updates.length === 0 ? (
            <div className="px-4 py-5 text-center text-xs text-muted-foreground">
              No new chapters — run Update Library to check your sources.
            </div>
          ) : (
            <ul className="max-h-80 overflow-auto py-1">
              {updates.slice(0, PREVIEW_LIMIT).map((update) => (
                <UpdateRow
                  key={update.mangaId}
                  update={update}
                  unread={!readNotifications.includes(update.mangaId)}
                  onNavigate={() => {
                    onOpenChange(false);
                    applyLibraryAction(
                      libraryActions.markNotificationRead(update.mangaId),
                      "Couldn't mark this update as read — try again.",
                    );
                  }}
                />
              ))}
            </ul>
          )}
          <Link
            href="/notifications"
            onClick={() => onOpenChange(false)}
            className="block border-t border-border/60 px-4 py-2.5 text-center text-[11px] font-medium text-primary transition hover:bg-accent"
          >
            View all notifications →
          </Link>
        </div>
      )}
    </div>
  );
}
