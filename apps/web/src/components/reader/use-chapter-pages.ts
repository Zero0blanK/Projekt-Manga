'use client';

import { useLatest } from '@/lib/use-latest';
import { useCallback, useEffect, useRef, useState } from 'react';

const EMPTY_PAGES: string[] = [];

/** Long enough to carry a preload into the chapter it was for. Image links from a source can
 * expire, so a resolved list isn't kept for long. */
const PAGE_LIST_TTL_MS = 5 * 60_000;
const PAGE_LISTS_KEPT = 8;

type Options<R> = {
  chapter: number;
  /** The release being read, once the chapter list has one for this number. */
  record: R | undefined;
  /** False where something else fetches the pages (the long strip) or nothing should load. */
  enabled: boolean;
  load: (record: R) => Promise<string[]>;
};

/**
 * The current chapter's page images.
 *
 * Tagged with the chapter they were fetched for, so `pageUrls` only exposes them when the tag
 * matches the current chapter: a late answer for a chapter since left can never render under
 * the wrong number, whatever raced what.
 *
 * `pagesFor` shares one request per release, so a preload that's already running or finished
 * isn't scraped again, by another page turn or by opening that chapter.
 */
export function useChapterPages<R extends { id: string }>({
  chapter,
  record,
  enabled,
  load,
}: Options<R>) {
  const [pagesData, setPagesData] = useState<{
    chapter: number;
    chapterId: string;
    urls: string[];
  } | null>(null);
  const [pagesError, setPagesError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const lists = useRef(new Map<string, { urls: Promise<string[]>; at: number }>());

  const pagesFor = useCallback((release: R): Promise<string[]> => {
    const held = lists.current.get(release.id);
    if (held && Date.now() - held.at < PAGE_LIST_TTL_MS) return held.urls;
    const urls = loadRef.current(release).then(
      (found) => {
        if (found.length === 0) lists.current.delete(release.id);
        return found;
      },
      (error: unknown) => {
        lists.current.delete(release.id);
        throw error;
      },
    );
    lists.current.delete(release.id);
    lists.current.set(release.id, { urls, at: Date.now() });
    if (lists.current.size > PAGE_LISTS_KEPT) {
      lists.current.delete(lists.current.keys().next().value!);
    }
    return urls;
  }, []);

  // Followed by id: the same release in a refreshed chapter list needs no new fetch.
  const recordRef = useLatest(record);
  const recordId = record?.id;
  useEffect(() => {
    if (!enabled) return;
    const release = recordRef.current;
    if (!release || recordId === undefined) {
      setPagesError(true);
      return;
    }
    let cancelled = false;
    setPagesError(false);
    pagesFor(release)
      .then((urls) => {
        if (cancelled) return;
        setPagesData({ chapter, chapterId: recordId, urls });
        setPagesError(urls.length === 0);
      })
      .catch(() => {
        if (!cancelled) setPagesError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [chapter, recordId, recordRef, enabled, attempt, pagesFor]);

  const pageUrls =
    pagesData?.chapter === chapter && pagesData.chapterId === record?.id
      ? pagesData.urls
      : EMPTY_PAGES;

  const retryPages = useCallback(() => {
    if (record) lists.current.delete(record.id);
    setAttempt((value) => value + 1);
  }, [record]);

  return { pageUrls, pagesError, pagesFor, retryPages };
}

/** Pages remembered per session. Only the newest matter: a page scrolled past long ago can
 * just load again. */
const LOADED_PAGES_KEPT = 5000;

/**
 * Whether the page on screen has finished loading, which is what makes it worth saving.
 *
 * In a ref, not state: the long strip reports every page of every chapter it passes, and only
 * a change to the page on screen needs a render.
 */
export function useLoadedPage(chapterId: string | undefined, page: number) {
  const loaded = useRef(new Set<string>());
  const [, rerender] = useState(0);
  const currentKey = chapterId ? `${chapterId}:${page}` : null;
  const currentRef = useRef(currentKey);
  currentRef.current = currentKey;

  const markPageLoaded = useCallback((id: string, pageNumber: number) => {
    const key = `${id}:${pageNumber}`;
    if (loaded.current.has(key)) return;
    loaded.current.add(key);
    if (loaded.current.size > LOADED_PAGES_KEPT) {
      loaded.current.delete(loaded.current.keys().next().value!);
    }
    if (key === currentRef.current) rerender((value) => value + 1);
  }, []);

  return { imageReady: !!currentKey && loaded.current.has(currentKey), markPageLoaded };
}
