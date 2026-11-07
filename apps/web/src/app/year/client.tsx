'use client';

import { useEffect, useMemo, useState } from 'react';
import { SelectMenu } from '@/components/ui/select-menu';
import { Download, Sparkles } from 'lucide-react';
import { type HistoryEntry } from '@projekt-manga/api-client';
import { EmptyState, PageHeader, PageShell } from '@/components/page-shell';
import { useMangaLibrary } from '@/lib/library-store';
import { historyYears, yearInManga, type YearInManga } from '@/lib/reading-stats';
import { useHistory } from '@/lib/shared-queries';

const MONTHS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];

const formatDay = (key: string) =>
  new Date(`${key}T00:00:00`).toLocaleDateString(undefined, { month: 'long', day: 'numeric' });

/**
 * Draws the year as a shareable picture, entirely in the browser: nothing is uploaded, and
 * "share" is saving the PNG.
 */
function drawCard(stats: YearInManga): Promise<Blob | null> {
  const canvas = document.createElement('canvas');
  canvas.width = 1080;
  canvas.height = 1350;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.resolve(null);
  const gradient = ctx.createLinearGradient(0, 0, 1080, 1350);
  gradient.addColorStop(0, '#1d1712');
  gradient.addColorStop(1, '#3a2614');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 1080, 1350);
  ctx.fillStyle = '#e9a25a';
  ctx.font = '600 44px system-ui, sans-serif';
  ctx.fillText(`My ${stats.year} in manga`, 80, 140);
  const big = (label: string, value: string, x: number, y: number) => {
    ctx.fillStyle = '#f4f0ea';
    ctx.font = '700 96px system-ui, sans-serif';
    ctx.fillText(value, x, y);
    ctx.fillStyle = '#a39c8f';
    ctx.font = '400 32px system-ui, sans-serif';
    ctx.fillText(label, x, y + 48);
  };
  big('chapters', String(stats.chapters), 80, 300);
  big('titles', String(stats.titles), 560, 300);
  big('hours read', String(stats.hours), 80, 520);
  big('longest streak (days)', String(stats.longestStreak), 560, 520);
  ctx.fillStyle = '#f4f0ea';
  ctx.font = '600 36px system-ui, sans-serif';
  ctx.fillText('Most read', 80, 700);
  ctx.font = '400 32px system-ui, sans-serif';
  stats.topTitles.forEach((entry, index) => {
    const title = entry.title.length > 38 ? `${entry.title.slice(0, 37)}…` : entry.title;
    ctx.fillText(`${index + 1}. ${title} · ${entry.chapters}`, 80, 760 + index * 52);
  });
  // Chapters per month.
  const max = Math.max(1, ...stats.months);
  stats.months.forEach((count, index) => {
    const height = Math.round((count / max) * 220);
    ctx.fillStyle = '#e9a25a';
    ctx.fillRect(80 + index * 78, 1230 - height, 52, height);
    ctx.fillStyle = '#a39c8f';
    ctx.font = '400 26px system-ui, sans-serif';
    ctx.fillText(MONTHS[index], 94 + index * 78, 1275);
  });
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

/** "Your year in manga": a yearly summary of the reading history, made on this device. */
export function YearInMangaClient() {
  const { manga: library } = useMangaLibrary();
  const { data, isError: failed } = useHistory();
  const history: HistoryEntry[] | null = data ?? null;
  const [year, setYear] = useState<number | null>(null);

  const years = useMemo(() => (history ? historyYears(history) : []), [history]);
  const shown = year ?? years[0] ?? new Date().getFullYear();
  const stats = useMemo(() => {
    if (!history) return null;
    const tagsById = new Map(library.map((manga) => [manga.id, manga.tags]));
    const tagsBySlug = new Map(
      library.map((manga) => [`${manga.source}:${manga.slug}`, manga.tags]),
    );
    return yearInManga(
      history,
      shown,
      (entry) =>
        (entry.manga_id && tagsById.get(entry.manga_id)) ||
        tagsBySlug.get(`${(entry as HistoryEntry).source}:${entry.manga_slug}`) ||
        [],
    );
  }, [history, library, shown]);

  const save = async () => {
    if (!stats) return;
    const blob = await drawCard(stats);
    if (!blob) return;
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = `projekt-manga-${stats.year}.png`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(href), 10_000);
  };

  return (
    <PageShell>
      <PageHeader
        icon={Sparkles}
        eyebrow="Year in manga"
        title={`Your ${shown} in manga`}
        description="Made on this device from your reading history. Nothing is uploaded."
        actions={
          stats && stats.chapters > 0 ? (
            <div className="flex items-center gap-2">
              {years.length > 1 && (
                <SelectMenu
                  label="Year"
                  value={String(shown)}
                  onChange={(option) => setYear(Number(option))}
                  options={years.map((option) => ({
                    value: String(option),
                    label: String(option),
                  }))}
                  className="min-w-24"
                />
              )}
              <button
                type="button"
                onClick={() => void save()}
                className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground"
              >
                <Download className="h-4 w-4" /> Save as image
              </button>
            </div>
          ) : undefined
        }
      />
      {failed ? (
        <div className="mt-8">
          <EmptyState icon={Sparkles}>Your reading history couldn&apos;t be loaded.</EmptyState>
        </div>
      ) : !stats ? (
        <p role="status" className="mt-8 text-sm text-muted-foreground">
          Loading…
        </p>
      ) : stats.chapters === 0 ? (
        <div className="mt-8">
          <EmptyState icon={Sparkles}>
            Nothing read in {shown} yet. Your year fills in as you read.
          </EmptyState>
        </div>
      ) : (
        <div className="mt-8 space-y-8">
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ['Chapters', stats.chapters],
              ['Titles', stats.titles],
              ['Hours read', stats.hours],
              [
                'Longest streak',
                `${stats.longestStreak} day${stats.longestStreak === 1 ? '' : 's'}`,
              ],
            ].map(([label, value]) => (
              <div key={label} className="rounded-2xl border border-border/60 bg-surface/40 p-4">
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="mt-1 text-3xl font-semibold tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
          <section aria-labelledby="year-months">
            <h2 id="year-months" className="text-sm font-semibold">
              Chapters by month
            </h2>
            <div className="mt-3 flex h-32 items-end gap-2" role="list">
              {stats.months.map((count, index) => {
                const max = Math.max(1, ...stats.months);
                return (
                  <div
                    key={index}
                    role="listitem"
                    aria-label={`${new Date(stats.year, index).toLocaleDateString(undefined, { month: 'long' })}: ${count}`}
                    className="flex flex-1 flex-col items-center gap-1"
                  >
                    <div
                      className="w-full rounded-t bg-primary/80"
                      style={{ height: `${Math.max(count ? 4 : 0, (count / max) * 100)}%` }}
                    />
                    <span className="text-xs text-muted-foreground">{MONTHS[index]}</span>
                  </div>
                );
              })}
            </div>
          </section>
          <div className="grid gap-6 sm:grid-cols-2">
            <section aria-labelledby="year-titles">
              <h2 id="year-titles" className="text-sm font-semibold">
                Most read
              </h2>
              <ol className="mt-2 space-y-1 text-sm">
                {stats.topTitles.map((entry) => (
                  <li key={entry.title} className="flex justify-between gap-3">
                    <span className="truncate">{entry.title}</span>
                    <span className="tabular-nums text-muted-foreground">{entry.chapters}</span>
                  </li>
                ))}
              </ol>
            </section>
            <section aria-labelledby="year-genres">
              <h2 id="year-genres" className="text-sm font-semibold">
                Top genres
              </h2>
              {stats.topGenres.length === 0 ? (
                <p className="mt-2 text-sm text-muted-foreground">
                  Genres come from library titles; none of this year&apos;s reading has them.
                </p>
              ) : (
                <ol className="mt-2 space-y-1 text-sm">
                  {stats.topGenres.map((entry) => (
                    <li key={entry.genre} className="flex justify-between gap-3">
                      <span className="truncate">{entry.genre}</span>
                      <span className="tabular-nums text-muted-foreground">{entry.chapters}</span>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </div>
          {stats.busiestDay && (
            <p className="text-sm text-muted-foreground">
              Busiest day: {formatDay(stats.busiestDay.date)}, with {stats.busiestDay.chapters}{' '}
              chapter{stats.busiestDay.chapters === 1 ? '' : 's'}.
            </p>
          )}
        </div>
      )}
    </PageShell>
  );
}
