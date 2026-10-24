'use client';

import { useEffect, useState } from 'react';
import { ChapterListPanel } from '@/components/reader/chapter-list-panel';
import { ExitReaderButton } from '@/components/reader/exit-reader-button';
import { ReaderSettingsMenu } from '@/components/reader/reader-settings-menu';
import type { Manga } from '@/lib/manga-data';
import type { MangaChapterRecord } from '@projekt-manga/api-client';
import { X, Minimize2, List, ZoomIn, ZoomOut } from 'lucide-react';

export function ReaderHeader({
  manga,
  chapters,
  chapter,
  chapterId,
  title,
  zoom,
  zoomMin,
  zoomMax,
  onZoomIn,
  onZoomOut,
  onZoomReset,
}: {
  manga: Manga;
  chapters: MangaChapterRecord[];
  chapter: number;
  chapterId?: string;
  title: string;
  zoom: number;
  zoomMin: number;
  zoomMax: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
}) {
  const [chapterListOpen, setChapterListOpen] = useState(false);

  return (
    <div className="flex h-14 items-center gap-4 border-b border-white/10 bg-black/80 px-4 backdrop-blur-xl">
      <ExitReaderButton
        fallbackHref={`/manga/${manga.id}`}
        label="Close reader"
        escapeKey
        className="grid h-9 w-9 place-items-center rounded-lg text-white/70 hover:bg-white/5 hover:text-white"
      >
        <X className="h-4 w-4" />
      </ExitReaderButton>
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold text-white">{manga.title}</div>
        <div className="truncate text-[11px] text-white/50">
          Chapter {chapter} · {title}
        </div>
      </div>
      <div className="relative ml-auto flex items-center gap-1">
        <button
          onClick={() => setChapterListOpen((v) => !v)}
          aria-expanded={chapterListOpen}
          aria-label="Chapter list"
          className={`grid h-9 w-9 place-items-center rounded-lg transition ${
            chapterListOpen
              ? 'bg-white/10 text-white'
              : 'text-white/70 hover:bg-white/5 hover:text-white'
          }`}
        >
          <List className="h-4 w-4" />
        </button>
        <div className="flex items-center gap-0.5 rounded-lg border border-white/10 px-0.5">
          <button
            onClick={onZoomOut}
            disabled={zoom <= zoomMin}
            aria-label="Zoom out"
            className="grid h-8 w-8 place-items-center pointer-coarse:size-11 rounded-md text-white/70 transition hover:bg-white/5 hover:text-white disabled:pointer-events-none disabled:opacity-30"
          >
            <ZoomOut className="h-4 w-4" />
          </button>
          <button
            onClick={onZoomReset}
            aria-label="Reset zoom"
            title="Reset zoom"
            className="w-11 text-center text-xs tabular-nums text-white/60 transition hover:text-white"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            onClick={onZoomIn}
            disabled={zoom >= zoomMax}
            aria-label="Zoom in"
            className="grid h-8 w-8 place-items-center pointer-coarse:size-11 rounded-md text-white/70 transition hover:bg-white/5 hover:text-white disabled:pointer-events-none disabled:opacity-30"
          >
            <ZoomIn className="h-4 w-4" />
          </button>
        </div>
        <ReaderSettingsMenu />
        <ExitReaderButton
          fallbackHref={`/manga/${manga.id}`}
          label="Exit reader"
          className="grid h-9 w-9 place-items-center rounded-lg text-white/70 hover:bg-white/5 hover:text-white"
        >
          <Minimize2 className="h-4 w-4" />
        </ExitReaderButton>

        {chapterListOpen && (
          <ChapterListPanelWithEscape onClose={() => setChapterListOpen(false)} />
        )}
        {chapterListOpen && (
          <ChapterListPanel
            mangaId={manga.id}
            chapters={chapters}
            activeChapter={chapter}
            activeChapterId={chapterId}
            onClose={() => setChapterListOpen(false)}
          />
        )}
      </div>
    </div>
  );
}

/** While the chapter list is open, Escape closes it instead of leaving the reader. */
function ChapterListPanelWithEscape({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return <span data-escape-closes hidden />;
}
