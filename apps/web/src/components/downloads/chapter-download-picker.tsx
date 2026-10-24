'use client';
import { useEffect, useRef, useState } from 'react';
import { initiateDownload, getAllDownloads } from '@projekt-manga/api-client';
import type { Manga } from '@/lib/manga-data';
import { refreshDownloads } from './row-data';
import { useCurrentUser } from '@/lib/session-resource';
export type DownloadCandidate = { id: string; n: number; title: string; read: boolean };
export function ChapterDownloadPicker({
  manga,
  chapters,
  selectedIds,
  excludedIds,
  available,
  onQueued,
}: {
  manga: Manga;
  chapters: DownloadCandidate[];
  selectedIds: string[];
  excludedIds: Set<string>;
  available: boolean;
  onQueued: (ids: string[]) => void;
}) {
  const [mode, setMode] = useState('selected');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const active = useRef(true);
  const generation = useRef(0);
  const running = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);
  const { user, loading: sessionLoading } = useCurrentUser();
  useEffect(() => {
    active.current = true;
    generation.current += 1;
    running.current = false;
    setBusy(false);
    setMessage('');
    return () => {
      controllerRef.current?.abort();
      active.current = false;
      generation.current += 1;
    };
  }, [user?.id, manga.id, sessionLoading]);
  const allowed = chapters.filter((chapter) => !excludedIds.has(chapter.id));
  const validRange =
    from.trim() !== '' &&
    to.trim() !== '' &&
    Number.isFinite(Number(from)) &&
    Number.isFinite(Number(to)) &&
    Number(from) <= Number(to);
  const targets =
    mode === 'next'
      ? [...allowed]
          .filter((chapter) => !chapter.read)
          .sort((a, b) => a.n - b.n)
          .slice(0, 5)
      : mode === 'range'
        ? validRange
          ? allowed.filter((chapter) => chapter.n >= Number(from) && chapter.n <= Number(to))
          : []
        : allowed.filter((chapter) => selectedIds.includes(chapter.id));
  const queue = async () => {
    if (running.current || sessionLoading || !available || targets.length === 0) return;
    running.current = true;
    setBusy(true);
    setMessage('');
    const requestGeneration = generation.current;
    const controller = new AbortController();
    controllerRef.current = controller;
    const queued: string[] = [],
      failed: string[] = [];
    try {
      let blocked: Set<string>;
      try {
        blocked = new Set(
          (await getAllDownloads(controller.signal))
            .filter((download) => download.status !== 'FAILED')
            .map((download) => download.chapter_id),
        );
      } catch {
        if (active.current && generation.current === requestGeneration)
          setMessage('Could not refresh download status. No chapters were queued; try again.');
        return;
      }
      const existing = targets
        .filter((chapter) => blocked.has(chapter.id))
        .map((chapter) => chapter.id);
      if (active.current && generation.current === requestGeneration && existing.length)
        onQueued(existing);
      for (const chapter of targets) {
        if (!active.current || generation.current !== requestGeneration) break;
        if (blocked.has(chapter.id)) continue;
        try {
          await initiateDownload(
            {
              sourceId: manga.source,
              mangaSlug: manga.slug,
              mangaTitle: manga.title,
              chapter: { id: chapter.id, name: chapter.title, chapter_number: chapter.n },
            },
            controller.signal,
          );
          queued.push(chapter.id);
        } catch {
          failed.push(chapter.id);
        }
      }
      refreshDownloads();
      if (active.current && generation.current === requestGeneration) {
        onQueued(queued);
        setMessage(
          `Queued ${queued.length} of ${targets.length - existing.length} available chapters.${existing.length ? ` Skipped ${existing.length} already active or completed.` : ''}${failed.length ? ` ${failed.length} failed; they remain available for retry.` : ''}`,
        );
      }
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      if (generation.current === requestGeneration) {
        running.current = false;
        if (active.current) setBusy(false);
      }
    }
  };
  return (
    <div className="mt-4 rounded-xl border border-border p-4">
      <h3 className="text-sm font-semibold">Download chapters</h3>
      <label className="mt-2 block text-xs">
        Choose chapters
        <select
          value={mode}
          disabled={busy}
          onChange={(event) => setMode(event.target.value)}
          className="ml-2 rounded-lg border border-border bg-background px-2 py-1"
        >
          <option value="selected">Selected chapters</option>
          <option value="next">Next five unread</option>
          <option value="range">Chapter range</option>
        </select>
      </label>
      {mode === 'range' && (
        <div className="mt-2 flex flex-wrap gap-3">
          {[
            ['from', from, setFrom],
            ['to', to, setTo],
          ].map(([label, value, setter]) => (
            <label key={label as string} className="text-xs">
              {label as string}
              <input
                type="number"
                step="any"
                disabled={busy}
                value={value as string}
                onChange={(event) => (setter as (value: string) => void)(event.target.value)}
                className="ml-2 w-24 rounded border border-border bg-background px-2 py-1"
              />
            </label>
          ))}
        </div>
      )}
      <p className="mt-2 text-xs text-muted-foreground">
        Preview: {targets.length} chapters. Completed and active downloads are excluded.
        {mode === 'range' && !validRange ? ' Enter a valid inclusive range.' : ''}
      </p>
      {!available && (
        <p role="status" className="mt-2 text-xs text-destructive">
          Download status is unavailable. Refresh this page before queuing.
        </p>
      )}
      <button
        type="button"
        disabled={busy || sessionLoading || !available || targets.length === 0}
        onClick={() => void queue()}
        className="mt-3 rounded-lg border border-border px-3 py-2 text-xs text-primary disabled:opacity-50"
      >
        {busy ? 'Queuing…' : `Queue ${targets.length} chapters`}
      </button>
      {message && (
        <p role="status" className="mt-2 text-xs">
          {message}
        </p>
      )}
    </div>
  );
}
