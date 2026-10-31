'use client';

import { useEffect, useState } from 'react';
import { ArrowLeft, Loader2, Search } from 'lucide-react';
import {
  buildImageProxyUrl,
  getSourceMangaDetails,
  searchSourceMangaPage,
} from '@projekt-manga/api-client';
import type { MangaDetails, Mangas } from '@projekt-manga/types';
import type { Manga } from '@/lib/manga-data';
import type { FoundTitle } from '@/lib/title-match';
import { Cover } from '@/components/cover';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

type SourceLabel = { id: string; name: string };

type View = { kind: 'preview'; found: FoundTitle } | { kind: 'search' };

const toFound = (item: Mangas): FoundTitle => ({
  sourceId: item.source,
  slug: item.slug || item.id,
  title: item.title,
  thumbnailUrl: item.thumbnail_url,
  score: 1,
});

/**
 * One title of a bulk migration: previews the replacement it will move to, or searches the
 * target sources by hand for one and previews it before it is used.
 */
export function MatchDialog({
  manga,
  match,
  sources,
  startWithSearch,
  onUse,
  onClose,
}: {
  manga: Manga;
  match: FoundTitle | null;
  /** The sources the reader chose to migrate to, in order. */
  sources: SourceLabel[];
  startWithSearch: boolean;
  onUse: (found: FoundTitle) => void;
  onClose: () => void;
}) {
  const [view, setView] = useState<View>(
    match && !startWithSearch ? { kind: 'preview', found: match } : { kind: 'search' },
  );
  const [query, setQuery] = useState(manga.title);
  const [sourceId, setSourceId] = useState(match?.sourceId ?? sources[0]?.id ?? '');
  const [results, setResults] = useState<{
    state: 'idle' | 'loading' | 'error' | 'ready';
    items: Mangas[];
  }>({ state: 'idle', items: [] });
  const [details, setDetails] = useState<{
    key: string;
    state: 'loading' | 'error' | 'ready';
    value: MangaDetails | null;
  } | null>(null);
  const nameOf = (id: string) => sources.find((source) => source.id === id)?.name ?? id;

  const search = (source = sourceId) => {
    if (!source || !query.trim()) return;
    setSourceId(source);
    setResults({ state: 'loading', items: [] });
    searchSourceMangaPage(source, { query: query.trim(), limit: 30 }).then(
      (page) => setResults({ state: 'ready', items: page.items }),
      () => setResults({ state: 'error', items: [] }),
    );
  };
  // The first search runs on its own when the dialog opens on it.
  useEffect(() => {
    if (view.kind === 'search' && results.state === 'idle') search();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.kind]);

  const previewKey = view.kind === 'preview' ? `${view.found.sourceId}\0${view.found.slug}` : '';
  useEffect(() => {
    if (view.kind !== 'preview') return;
    const controller = new AbortController();
    setDetails({ key: previewKey, state: 'loading', value: null });
    getSourceMangaDetails(view.found.sourceId, view.found.slug, controller.signal).then(
      (value) => setDetails({ key: previewKey, state: 'ready', value }),
      () => {
        if (!controller.signal.aborted)
          setDetails({ key: previewKey, state: 'error', value: null });
      },
    );
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey]);

  const shown = details?.key === previewKey ? details : null;
  const chapters = shown?.value?.chapters ?? [];
  const latest = chapters.reduce(
    (best, chapter) =>
      Math.max(best, Number.isFinite(chapter.chapter_number) ? chapter.chapter_number : 0),
    0,
  );

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {view.kind === 'preview' ? 'Replacement' : 'Choose a replacement'}
          </DialogTitle>
          <DialogDescription>
            For <span className="font-medium text-foreground">{manga.title}</span>
          </DialogDescription>
        </DialogHeader>
        {view.kind === 'preview' ? (
          <div className="space-y-4">
            <div className="flex gap-4">
              <Cover
                src={
                  (shown?.value?.thumbnail_url ?? view.found.thumbnailUrl)
                    ? buildImageProxyUrl(
                        shown?.value?.thumbnail_url ?? view.found.thumbnailUrl,
                        view.found.sourceId,
                      )
                    : null
                }
                alt=""
                className="aspect-[2/3] w-28 shrink-0 sm:w-32"
              />
              <div className="min-w-0 flex-1 space-y-1.5 text-sm">
                <h3 className="text-base font-semibold leading-snug">
                  {shown?.value?.title ?? view.found.title}
                </h3>
                <p className="text-muted-foreground">{nameOf(view.found.sourceId)}</p>
                {shown?.state === 'loading' && (
                  <p className="flex items-center gap-2 text-muted-foreground">
                    <Loader2 size={14} className="animate-spin" aria-hidden="true" /> Loading
                    details…
                  </p>
                )}
                {shown?.state === 'error' && (
                  <p className="text-destructive">The source could not load this title.</p>
                )}
                {shown?.value && (
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                    {!!shown.value.author?.length && (
                      <>
                        <dt className="text-muted-foreground">Author</dt>
                        <dd>{shown.value.author.join(', ')}</dd>
                      </>
                    )}
                    <dt className="text-muted-foreground">Status</dt>
                    <dd className="capitalize">{shown.value.status.toLowerCase() || 'unknown'}</dd>
                    <dt className="text-muted-foreground">Chapters</dt>
                    <dd>
                      {chapters.length}
                      {latest > 0 && ` · up to ${latest}`}
                      <span className="text-muted-foreground"> (yours: {manga.chapters})</span>
                    </dd>
                    {!!shown.value.genres.length && (
                      <>
                        <dt className="text-muted-foreground">Genres</dt>
                        <dd>{shown.value.genres.slice(0, 8).join(', ')}</dd>
                      </>
                    )}
                  </dl>
                )}
              </div>
            </div>
            {shown?.value?.description && (
              <p className="line-clamp-6 whitespace-pre-line text-sm text-muted-foreground">
                {shown.value.description}
              </p>
            )}
            <div className="flex flex-wrap justify-between gap-2">
              <Button type="button" variant="ghost" onClick={() => setView({ kind: 'search' })}>
                <Search size={15} className="mr-1.5" aria-hidden="true" />
                Search for another
              </Button>
              <Button
                type="button"
                disabled={shown?.state !== 'ready'}
                onClick={() => {
                  onUse(view.found);
                  onClose();
                }}
              >
                {match && match.sourceId === view.found.sourceId && match.slug === view.found.slug
                  ? 'Keep this one'
                  : 'Use this one'}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {match && (
              <button
                type="button"
                onClick={() => setView({ kind: 'preview', found: match })}
                className="flex items-center gap-1.5 text-xs text-primary hover:underline"
              >
                <ArrowLeft size={13} aria-hidden="true" /> Back to the current match
              </button>
            )}
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                search();
              }}
            >
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label="Title to search for"
                className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
              />
              <Button type="submit" size="sm" disabled={!query.trim()}>
                Search
              </Button>
            </form>
            <div role="tablist" aria-label="Source to search" className="flex flex-wrap gap-1.5">
              {sources.map((source) => (
                <button
                  key={source.id}
                  type="button"
                  role="tab"
                  aria-selected={source.id === sourceId}
                  onClick={() => search(source.id)}
                  className={`rounded-full border px-3 py-1 text-xs transition ${
                    source.id === sourceId
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border/60 text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {source.name}
                </button>
              ))}
            </div>
            {results.state === 'loading' ? (
              <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                <Loader2 size={15} className="animate-spin" aria-hidden="true" /> Searching{' '}
                {nameOf(sourceId)}…
              </p>
            ) : results.state === 'error' ? (
              <p className="py-6 text-sm text-destructive">
                {nameOf(sourceId)} could not be searched.
              </p>
            ) : results.state === 'ready' && !results.items.length ? (
              <p className="py-6 text-sm text-muted-foreground">
                Nothing found on {nameOf(sourceId)}. Try another source or a different title.
              </p>
            ) : (
              <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4">
                {results.items.map((item) => (
                  <li key={`${item.source}:${item.id}`}>
                    <button
                      type="button"
                      onClick={() => setView({ kind: 'preview', found: toFound(item) })}
                      className="group w-full text-left"
                    >
                      <Cover
                        src={
                          item.thumbnail_url
                            ? buildImageProxyUrl(item.thumbnail_url, item.source)
                            : null
                        }
                        alt=""
                        className="aspect-[2/3] w-full transition group-hover:ring-2 group-hover:ring-primary"
                      />
                      <span className="mt-1 line-clamp-2 text-xs font-medium">{item.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
