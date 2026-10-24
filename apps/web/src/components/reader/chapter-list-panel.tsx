'use client';

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type { KeyboardEvent, UIEvent } from 'react';
import type { MangaChapterRecord } from '@projekt-manga/api-client';
import { knownGroup } from '@/lib/manga-data';

const ROW_HEIGHT = 32;
const LIST_HEIGHT = 320;
const OVERSCAN_ROWS = 8;
const WINDOW_ROWS = LIST_HEIGHT / ROW_HEIGHT + OVERSCAN_ROWS * 2;

export function ChapterListPanel({
  mangaId,
  chapters,
  activeChapter,
  activeChapterId,
  onClose,
}: {
  mangaId: string;
  chapters: MangaChapterRecord[];
  activeChapter: number;
  activeChapterId?: string;
  onClose: () => void;
}) {
  const sorted = useMemo(
    () => [...chapters].sort((a, b) => b.chapter_number - a.chapter_number),
    [chapters],
  );
  const listRef = useRef<HTMLDivElement>(null);
  const pendingKeyboardFocusIndex = useRef<number | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const activeIndex = sorted.findIndex((chapter) =>
    activeChapterId ? chapter.id === activeChapterId : chapter.chapter_number === activeChapter,
  );

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || activeIndex < 0) return;
    const nextScrollTop = Math.max(0, (activeIndex - OVERSCAN_ROWS / 2) * ROW_HEIGHT);
    list.scrollTop = nextScrollTop;
    setScrollTop(nextScrollTop);
  }, [activeIndex]);

  const startIndex = Math.min(
    Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN_ROWS),
    Math.max(0, sorted.length - WINDOW_ROWS),
  );
  const endIndex = Math.min(sorted.length, startIndex + WINDOW_ROWS);
  const visibleChapters = sorted.slice(startIndex, endIndex);

  // A keyboard jump outside the window (Home/End/PageUp/PageDown) is focused in the commit
  // that mounts its row. Polling a few animation frames instead gave up whenever a long
  // list took longer than that to render, leaving focus on an unmounted row.
  useLayoutEffect(() => {
    const pending = pendingKeyboardFocusIndex.current;
    if (pending === null || pending < startIndex || pending >= endIndex) return;
    pendingKeyboardFocusIndex.current = null;
    listRef.current?.querySelector<HTMLElement>(`[data-chapter-index="${pending}"]`)?.focus();
  });

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    const list = event.currentTarget;
    const nextScrollTop = list.scrollTop;
    setScrollTop(nextScrollTop);
    if (pendingKeyboardFocusIndex.current !== null) return;

    const focused = document.activeElement;
    const focusedIndex =
      focused instanceof HTMLElement && list.contains(focused)
        ? Number(focused.dataset.chapterIndex)
        : Number.NaN;
    if (!Number.isInteger(focusedIndex)) return;

    const nextStart = Math.min(
      Math.max(0, Math.floor(nextScrollTop / ROW_HEIGHT) - OVERSCAN_ROWS),
      Math.max(0, sorted.length - WINDOW_ROWS),
    );
    const nextEnd = Math.min(sorted.length, nextStart + WINDOW_ROWS);
    if (focusedIndex >= nextStart && focusedIndex < nextEnd) return;

    const targetIndex = Math.min(Math.max(focusedIndex, nextStart), nextEnd - 1);
    requestAnimationFrame(() => {
      list.querySelector<HTMLElement>(`[data-chapter-index="${targetIndex}"]`)?.focus();
    });
  };

  const handleChapterKeyDown = (event: KeyboardEvent<HTMLAnchorElement>, index: number) => {
    let nextIndex: number | null = null;
    if (event.key === 'ArrowDown') nextIndex = Math.min(sorted.length - 1, index + 1);
    else if (event.key === 'ArrowUp') nextIndex = Math.max(0, index - 1);
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = sorted.length - 1;
    else if (event.key === 'PageDown')
      nextIndex = Math.min(sorted.length - 1, index + Math.floor(LIST_HEIGHT / ROW_HEIGHT));
    else if (event.key === 'PageUp')
      nextIndex = Math.max(0, index - Math.floor(LIST_HEIGHT / ROW_HEIGHT));
    if (nextIndex === null || nextIndex === index) return;

    event.preventDefault();
    const list = listRef.current;
    if (!list) return;
    list.scrollTop = Math.max(0, (nextIndex - OVERSCAN_ROWS) * ROW_HEIGHT);
    const mounted = list.querySelector<HTMLElement>(`[data-chapter-index="${nextIndex}"]`);
    if (mounted) {
      mounted.focus();
    } else {
      // Picked up by the layout effect once the scroll re-renders the window.
      pendingKeyboardFocusIndex.current = nextIndex;
    }
    setScrollTop(list.scrollTop);
  };

  return (
    <>
      <button
        type="button"
        tabIndex={-1}
        aria-label="Close chapter list"
        className="fixed inset-0 z-10"
        onClick={onClose}
      />
      <div
        ref={listRef}
        role="list"
        aria-label="Chapters"
        onScroll={handleScroll}
        className="absolute right-0 top-11 z-20 h-80 w-64 overflow-auto rounded-xl border border-white/10 bg-black/95 py-1.5 shadow-lg backdrop-blur-xl"
      >
        {startIndex > 0 && <div aria-hidden="true" style={{ height: startIndex * ROW_HEIGHT }} />}
        {visibleChapters.map((chapter, offset) => {
          const index = startIndex + offset;
          return (
            <div
              key={chapter.id}
              role="listitem"
              aria-posinset={index + 1}
              aria-setsize={sorted.length}
              className="h-8"
            >
              <Link
                href={`/reader/${mangaId}?ch=${chapter.chapter_number}&chapterId=${encodeURIComponent(chapter.id)}`}
                data-chapter-index={index}
                onClick={onClose}
                onKeyDown={(event) => handleChapterKeyDown(event, index)}
                aria-label={`Chapter ${chapter.chapter_number}${chapter.name ? `, ${chapter.name}` : ''}, ${index + 1} of ${sorted.length}`}
                className={`flex h-full items-center justify-between gap-2 overflow-hidden px-3 text-xs transition hover:bg-white/5 ${
                  (
                    activeChapterId
                      ? chapter.id === activeChapterId
                      : chapter.chapter_number === activeChapter
                  )
                    ? 'text-primary'
                    : 'text-white/70'
                }`}
              >
                <span className="truncate">
                  Ch. {chapter.chapter_number}
                  {chapter.name ? ` · ${chapter.name}` : ''}
                </span>
                {knownGroup(chapter.scanlator) && (
                  <span className="shrink-0 text-[10px] text-white/40">
                    {knownGroup(chapter.scanlator)}
                  </span>
                )}
              </Link>
            </div>
          );
        })}
        {endIndex < sorted.length && (
          <div aria-hidden="true" style={{ height: (sorted.length - endIndex) * ROW_HEIGHT }} />
        )}
        {sorted.length === 0 && (
          <div className="px-3 py-4 text-center text-xs text-white/40">No chapters yet.</div>
        )}
      </div>
    </>
  );
}
