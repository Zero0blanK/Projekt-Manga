'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowDown, ArrowUp, Layers, Plus, X } from 'lucide-react';
import {
  getMangaChapters,
  getMangaLinks,
  reorderMangaLinks,
  unlinkMangaSource,
  type MangaChapterRecord,
  type MangaLinkGroup,
} from '@projekt-manga/api-client';
import { useSources } from '@/lib/library-store';
import { toast } from '@/hooks/use-toast';
import type { Manga } from '@/lib/manga-data';

/** A server without linked sources answers with something else; treat that as none. */
export const isLinkGroup = (value: unknown): value is MangaLinkGroup =>
  !!value &&
  typeof value === 'object' &&
  typeof (value as MangaLinkGroup).primary_id === 'string' &&
  Array.isArray((value as MangaLinkGroup).links);

/** How many chapters only a linked source has are listed before "and N more". */
const EXTRA_LIMIT = 30;

/**
 * Linked sources (other sources' copies of this title), on its page. Lists them in the
 * order they are tried, lets them be reordered or unlinked, and shows the chapters only
 * a linked source has, each opening in that source's reader. Shown only once there is
 * something to show, or as a single "link another source" action.
 */
export function LinkedSources({ manga }: { manga: Manga }) {
  const { sources } = useSources();
  const [group, setGroup] = useState<MangaLinkGroup | null>(null);
  const [extras, setExtras] = useState<
    Array<{ number: number; title: string; source: string; mangaId: string }>
  >([]);
  const [busy, setBusy] = useState(false);
  const sourceName = useCallback(
    (id: string) => sources.find((source) => source.id === id)?.name ?? id,
    [sources],
  );

  useEffect(() => {
    const controller = new AbortController();
    getMangaLinks(manga.id, controller.signal)
      .then((found) => setGroup(isLinkGroup(found) ? found : null))
      .catch(() => undefined);
    return () => controller.abort();
  }, [manga.id]);

  const isPrimary = !group || group.primary_id === manga.id;
  const links = useMemo(() => (isPrimary ? (group?.links ?? []) : []), [group, isPrimary]);

  // Chapters the linked sources have and this title lacks, by chapter number: the first
  // source in priority order that has a number supplies it.
  useEffect(() => {
    if (links.length === 0) {
      setExtras([]);
      return;
    }
    const controller = new AbortController();
    void (async () => {
      try {
        const own = await getMangaChapters(manga.id, manga.slug, manga.source, controller.signal);
        const have = new Set(own.map((chapter) => chapter.chapter_number));
        const found = new Map<number, { title: string; source: string; mangaId: string }>();
        for (const { linked } of links) {
          let chapters: MangaChapterRecord[] = [];
          try {
            chapters = await getMangaChapters(
              linked.id,
              linked.slug,
              linked.source,
              controller.signal,
            );
          } catch {
            continue; // one source being down doesn't hide the others
          }
          for (const chapter of chapters)
            if (!have.has(chapter.chapter_number) && !found.has(chapter.chapter_number))
              found.set(chapter.chapter_number, {
                title: chapter.name || `Chapter ${chapter.chapter_number}`,
                source: linked.source,
                mangaId: linked.id,
              });
        }
        if (!controller.signal.aborted)
          setExtras(
            [...found]
              .map(([number, extra]) => ({ number, ...extra }))
              .sort((a, b) => a.number - b.number),
          );
      } catch {
        /* the section still lists the links */
      }
    })();
    return () => controller.abort();
  }, [links, manga.id, manga.slug, manga.source]);

  const change = async (work: () => Promise<MangaLinkGroup>) => {
    if (busy) return;
    setBusy(true);
    try {
      setGroup(await work());
    } catch (error) {
      toast({
        variant: 'destructive',
        description:
          error instanceof Error && error.message ? error.message : "Couldn't save that change.",
      });
    } finally {
      setBusy(false);
    }
  };
  const move = (index: number, step: -1 | 1) => {
    const ids = links.map((link) => link.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(index + step, 0, moved);
    void change(() => reorderMangaLinks(manga.id, ids));
  };

  if (!group) return null;
  if (!isPrimary)
    return (
      <p className="mb-4 flex items-center gap-2 text-sm text-muted-foreground">
        <Layers size={14} aria-hidden />
        This is a linked source of{' '}
        <Link href={`/manga/${encodeURIComponent(group.primary_id)}`} className="underline">
          another title in your library
        </Link>
        .
      </p>
    );

  const linkHref = `/manga/${encodeURIComponent(manga.id)}/migrate`;
  if (links.length === 0)
    return (
      <div className="mb-4">
        <Link
          href={linkHref}
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary"
        >
          <Plus size={14} aria-hidden /> Link another source
        </Link>
      </div>
    );

  return (
    <section
      aria-labelledby="linked-sources"
      className="mb-6 rounded-xl border border-border/60 p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="linked-sources" className="flex items-center gap-2 text-sm font-semibold">
          <Layers size={16} aria-hidden /> Linked sources
        </h2>
        <Link
          href={linkHref}
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary"
        >
          <Plus size={14} aria-hidden /> Link another
        </Link>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        When this title lacks a chapter or won&apos;t load, the reader offers it from these, top
        first.
      </p>
      <ol className="mt-3 space-y-1.5">
        {links.map((link, index) => (
          <li key={link.id} className="flex items-center gap-2 text-sm">
            <span className="w-5 text-xs tabular-nums text-muted-foreground">{index + 1}.</span>
            <Link
              href={`/manga/${encodeURIComponent(link.linked.id)}`}
              className="min-w-0 flex-1 truncate hover:text-primary"
            >
              {sourceName(link.linked.source)}
              <span className="text-muted-foreground"> · {link.linked.title}</span>
            </Link>
            <button
              type="button"
              disabled={busy || index === 0}
              onClick={() => move(index, -1)}
              aria-label={`Try ${sourceName(link.linked.source)} earlier`}
              className="rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-30"
            >
              <ArrowUp size={14} />
            </button>
            <button
              type="button"
              disabled={busy || index === links.length - 1}
              onClick={() => move(index, 1)}
              aria-label={`Try ${sourceName(link.linked.source)} later`}
              className="rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-30"
            >
              <ArrowDown size={14} />
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void change(() => unlinkMangaSource(manga.id, link.id))}
              aria-label={`Unlink ${sourceName(link.linked.source)}`}
              className="rounded p-1 text-muted-foreground hover:text-destructive"
            >
              <X size={14} />
            </button>
          </li>
        ))}
      </ol>
      {extras.length > 0 && (
        <div className="mt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Only on linked sources
          </h3>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {extras.slice(0, EXTRA_LIMIT).map((extra) => (
              <li key={extra.number}>
                <Link
                  href={`/reader/${encodeURIComponent(extra.mangaId)}?ch=${extra.number}`}
                  title={`${extra.title} · ${sourceName(extra.source)}`}
                  className="inline-flex rounded-full border border-border/60 px-2.5 py-1 text-xs hover:border-primary/60 hover:text-primary"
                >
                  Ch {extra.number}
                  <span className="ml-1 text-muted-foreground">· {sourceName(extra.source)}</span>
                </Link>
              </li>
            ))}
            {extras.length > EXTRA_LIMIT && (
              <li className="px-1 py-1 text-xs text-muted-foreground">
                and {extras.length - EXTRA_LIMIT} more
              </li>
            )}
          </ul>
        </div>
      )}
    </section>
  );
}
