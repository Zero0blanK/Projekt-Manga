'use client';

import { useState } from 'react';
import Link from 'next/link';
import { buildImageProxyUrl } from '@projekt-manga/api-client';
import { formatRelative } from '@/lib/manga-data';
import { useLibraryState, libraryActions, applyLibraryAction } from '@/lib/library-store';
import {
  useRecentChapters,
  groupChaptersByManga,
  groupUpdatesByDay,
  type MangaUpdate,
} from '@/lib/notifications-store';
import { Cover } from '@/components/cover';
import { EmptyState, RowList } from '@/components/page-shell';
import { RowListSkeleton } from '@/components/skeletons';
import { BookOpen, Check, ChevronDown } from 'lucide-react';

/** Marking-read is incidental to following the link, so it stays fire-and-forget — but it
 * still routes through `applyLibraryAction` so a failed write rolls back and says so,
 * instead of becoming an unhandled rejection as the route changes underneath it. */
const markRead = (mangaId: string) =>
  applyLibraryAction(
    libraryActions.markNotificationRead(mangaId),
    "Couldn't mark this update as read — try again.",
  );

/** One title's worth of new chapters. The individual chapters live behind a dropdown
 * rather than as sibling rows, so a title that dropped eight chapters at once takes one
 * line in the feed instead of eight near-identical ones. */
function UpdateRow({ update, unread }: { update: MangaUpdate; unread: boolean }) {
  const [open, setOpen] = useState(false);
  const newest = update.chapters[0];
  const count = update.chapters.length;

  return (
    <li className={unread ? 'bg-primary/[0.04]' : undefined}>
      <div className="group flex items-center gap-4 p-4 transition hover:bg-accent/40">
        <span className="relative h-16 w-12 shrink-0">
          <Cover
            mangaId={update.mangaId}
            src={update.thumbnailUrl ? buildImageProxyUrl(update.thumbnailUrl) : null}
            alt={update.title}
            className="h-full w-full"
          />
          {unread && <span className="absolute left-1 top-1 h-1.5 w-1.5 rounded-full bg-primary" />}
        </span>

        <div className="min-w-0 flex-1">
          <Link
            href={`/manga/${update.mangaId}`}
            onClick={() => markRead(update.mangaId)}
            className={`truncate text-sm font-semibold group-hover:text-primary ${
              unread ? 'text-foreground' : 'text-muted-foreground'
            }`}
          >
            {update.title}
          </Link>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {count === 1
              ? `Chapter ${newest.chapter_number}`
              : `Chapters ${update.chapters[count - 1].chapter_number}–${newest.chapter_number}`}
          </p>
        </div>

        <div className="hidden shrink-0 text-right text-[11px] text-muted-foreground md:block">
          {update.fetchedAt ? formatRelative(update.fetchedAt) : ''}
        </div>

        {count > 1 ? (
          <button
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="flex shrink-0 items-center gap-1 rounded-full border border-border/60 px-3 py-1.5 text-[11px] font-medium text-foreground transition hover:bg-accent"
          >
            {count} chapters
            <ChevronDown className={`h-3 w-3 opacity-60 transition ${open ? 'rotate-180' : ''}`} />
          </button>
        ) : null}

        <button
          onClick={() =>
            unread
              ? markRead(update.mangaId)
              : applyLibraryAction(
                  libraryActions.markNotificationUnread(update.mangaId),
                  "Couldn't mark this update as unread — try again.",
                )
          }
          className="shrink-0 rounded-full border border-border/60 px-2.5 py-1 text-[10px] font-medium text-muted-foreground opacity-0 transition hover:text-foreground group-hover:opacity-100"
        >
          {unread ? 'Mark read' : 'Mark unread'}
        </button>

        <Link
          href={`/reader/${update.mangaId}?ch=${newest.chapter_number}`}
          onClick={() => markRead(update.mangaId)}
          className="flex shrink-0 items-center gap-1.5 rounded-full bg-foreground px-3 py-1.5 text-[11px] font-semibold text-background transition hover:opacity-90"
        >
          <BookOpen className="h-3 w-3" /> Read
        </Link>
      </div>

      {count > 1 && open && (
        <ul className="border-t border-border/50 bg-background/40">
          {update.chapters.map((chapter) => (
            <li key={chapter.id}>
              <Link
                href={`/reader/${update.mangaId}?ch=${chapter.chapter_number}`}
                onClick={() => markRead(update.mangaId)}
                className="flex items-center justify-between gap-3 py-2 pl-20 pr-4 text-xs text-muted-foreground transition hover:bg-accent/40 hover:text-foreground"
              >
                <span className="min-w-0 truncate">
                  Chapter {chapter.chapter_number}
                  {chapter.name ? ` · ${chapter.name}` : ''}
                </span>
                <span className="shrink-0 text-[10px]">
                  {chapter.fetched_at ? formatRelative(chapter.fetched_at) : ''}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * New chapters, bucketed by when the update run fetched them. `fetched_at` is the useful
 * axis here — it's "when this became new to you", whereas a chapter's own release date can
 * be years old the first time a source is scraped.
 */
export function ChapterUpdates() {
  const { chapters, loading } = useRecentChapters();
  const { readNotifications } = useLibraryState();

  const updates = groupChaptersByManga(chapters);
  const days = groupUpdatesByDay(updates);
  const unreadIds = updates
    .filter((u) => !readNotifications.includes(u.mangaId))
    .map((u) => u.mangaId);

  if (loading && updates.length === 0) {
    return <RowListSkeleton count={6} />;
  }

  if (!loading && updates.length === 0) {
    return <EmptyState>No new chapters yet — run Update Library to check your sources.</EmptyState>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {updates.length} title{updates.length === 1 ? '' : 's'} · {chapters.length} chapter
          {chapters.length === 1 ? '' : 's'}
          {unreadIds.length > 0 ? ` · ${unreadIds.length} unread` : ''}
        </p>
        {unreadIds.length > 0 && (
          <button
            onClick={() =>
              applyLibraryAction(
                libraryActions.markAllNotificationsRead(unreadIds),
                "Couldn't mark every update as read — try again.",
              )
            }
            className="flex shrink-0 items-center gap-2 rounded-lg border border-border/60 px-3 py-2 text-xs text-muted-foreground hover:text-foreground"
          >
            <Check className="h-3.5 w-3.5" /> Mark all as read
          </button>
        )}
      </div>

      {days.map((day) => (
        <section key={day.label}>
          <h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            {day.label}
            <span className="ml-2 font-normal normal-case tracking-normal opacity-70">
              {day.updates.length} title{day.updates.length === 1 ? '' : 's'}
            </span>
          </h2>
          <div className="mt-3">
            <RowList>
              {day.updates.map((update) => (
                <UpdateRow
                  key={update.mangaId}
                  update={update}
                  unread={!readNotifications.includes(update.mangaId)}
                />
              ))}
            </RowList>
          </div>
        </section>
      ))}
    </div>
  );
}
