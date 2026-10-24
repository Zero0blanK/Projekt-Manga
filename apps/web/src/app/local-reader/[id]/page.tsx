'use client';

import { use, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { localArchiveBridge, type LocalArchive } from '@/lib/local-archives';
import { useCurrentUser } from '@/lib/session-resource';
import { useProfilePreference } from '@/lib/profile-preferences';
import { useReaderSettings } from '@/lib/reader-settings';
import { PagedViewer } from '@/components/reader/paged-viewer';
import { ReaderProgressBar } from '@/components/reader/reader-progress-bar';
import type { Manga } from '@/lib/manga-data';

function parseLocalPage(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 2000
    ? value
    : 1;
}

export default function LocalReaderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { user, loading } = useCurrentUser();
  const [archive, setArchive] = useState<LocalArchive | null>(null);
  const [archiveOwner, setArchiveOwner] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [savedPage, savePage] = useProfilePreference(`local-archive-page:${id}`, parseLocalPage, 1);
  const [page, setPage] = useState(savedPage);
  const [urls, setUrls] = useState<string[]>([]);
  const activeUrls = useRef(new Map<number, string>());
  const pageRequestTail = useRef<Promise<void>>(Promise.resolve());
  const {
    readingDirection,
    effectiveLayout: pageLayout,
    pagePrefetchAhead,
    zoomBehavior,
    background,
    brightness,
  } = useReaderSettings();
  useEffect(() => {
    setPage(savedPage);
  }, [savedPage, id, user?.id]);
  useEffect(() => {
    setArchive(null);
    setUrls([]);
    setError('');
    const bridge = localArchiveBridge();
    if (loading) return;
    if (!bridge) {
      setError('Local CBZ reading is available in the desktop app.');
      return;
    }
    let cancelled = false;
    bridge
      .list()
      .then((items) => {
        if (cancelled) return;
        const found = items.find((item) => item.id === id);
        if (found) {
          setArchive(found);
          setArchiveOwner(user?.id ?? 'anonymous');
        } else setError('This local comic is unavailable in the current profile.');
      })
      .catch(() => {
        if (!cancelled) setError('The local comic could not be opened.');
      });
    return () => {
      cancelled = true;
    };
  }, [id, user?.id, loading, retry]);
  useEffect(() => {
    const retained = activeUrls.current;
    return () => {
      retained.forEach((url) => URL.revokeObjectURL(url));
      retained.clear();
    };
  }, [id, user?.id]);
  useEffect(() => {
    if (!archive || loading || archiveOwner !== (user?.id ?? 'anonymous')) return;
    const bridge = localArchiveBridge();
    if (!bridge) return;
    let cancelled = false;
    const first = Math.max(1, Math.min(archive.pageCount, page) - 1);
    const last = Math.min(archive.pageCount, page + Math.min(4, Math.max(2, pagePrefetchAhead)));
    void (async () => {
      const retained = activeUrls.current;
      for (const [number, url] of retained) {
        if (number < first || number > last) {
          URL.revokeObjectURL(url);
          retained.delete(number);
        }
      }
      setUrls(
        Array.from({ length: archive.pageCount }, (_, index) => retained.get(index + 1) ?? ''),
      );
      for (let number = first; number <= last; number += 1) {
        if (cancelled) return;
        if (retained.has(number)) continue;
        try {
          const operation = pageRequestTail.current.then(() =>
            cancelled ? null : bridge.page(id, number - 1),
          );
          pageRequestTail.current = operation.then(
            () => undefined,
            () => undefined,
          );
          const image = await operation;
          if (cancelled || !image) return;
          const url = URL.createObjectURL(
            new Blob([new Uint8Array(image.bytes)], { type: image.mime }),
          );
          retained.set(number, url);
          setUrls(
            Array.from({ length: archive.pageCount }, (_, index) => retained.get(index + 1) ?? ''),
          );
        } catch {
          if (!cancelled) setError(`Page ${number} could not be loaded. Retry keeps your place.`);
          return;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [archive, page, pagePrefetchAhead, id, loading, retry, archiveOwner, user?.id]);
  if (!archive || loading || archiveOwner !== (user?.id ?? 'anonymous'))
    return (
      <div className="mx-auto max-w-xl space-y-4 p-6">
        <p role={error ? 'alert' : 'status'}>{error || 'Opening local comic…'}</p>
        {error && (
          <button
            type="button"
            onClick={() => setRetry((value) => value + 1)}
            className="rounded border p-2"
          >
            Retry
          </button>
        )}
        <Link href="/local" className="block underline">
          Local collection
        </Link>
      </div>
    );
  const manga: Manga = {
    id: `local:${archive.id}`,
    slug: archive.id,
    title: archive.title,
    source: 'local-archive',
    authors: null,
    artists: null,
    groups: null,
    chapters: 1,
    latestChapter: '1',
    latestChapterNum: 1,
    updatedAt: archive.importedAt,
    status: 'Completed',
    tags: [],
    color: '',
    accent: '',
    synopsis: '',
    rating: null,
    thumbnailUrl: null,
    inLibrary: false,
  };
  const seek = (next: number) => setPage(Math.min(archive.pageCount, Math.max(1, next)));
  return (
    <div className="fixed inset-0 z-50 flex flex-col" style={{ background }}>
      <header className="flex flex-wrap items-center gap-4 border-b border-white/10 bg-black p-3 text-sm text-white">
        <Link href="/local" className="underline">
          Local collection
        </Link>
        <span className="min-w-0 flex-1 truncate">{archive.title}</span>
        <span>
          {page} / {archive.pageCount}
        </span>
        {pageLayout === 'Long strip' && (
          <span className="text-xs">Local comics use paged reading.</span>
        )}
      </header>
      {brightness < 100 && (
        <div
          aria-hidden
          className="pointer-events-none fixed inset-0 z-20 bg-black"
          style={{ opacity: (100 - brightness) / 100 }}
        />
      )}
      {error && (
        <p role="alert" className="bg-black p-3 text-center text-sm text-white">
          {error}
          <button
            type="button"
            className="ml-2 underline"
            onClick={() => {
              setError('');
              setRetry((value) => value + 1);
            }}
          >
            Retry page
          </button>
        </p>
      )}
      <PagedViewer
        key={`${id}:${user?.id ?? 'anonymous'}`}
        manga={manga}
        totalPages={archive.pageCount}
        pageUrls={urls}
        pagesPerView={pageLayout === 'Single page' ? 1 : 2}
        page={Math.min(page, archive.pageCount)}
        onPositionChange={(next) => {
          seek(next);
          savePage(next);
        }}
        onVisiblePage={seek}
        hasNextChapter={false}
        nextChapterNumber={0}
        onRequestNextChapter={() => undefined}
        hasPrevChapter={false}
        prevChapterNumber={0}
        onRequestPrevChapter={() => undefined}
        readingDirection={readingDirection}
        fitOverride={zoomBehavior}
        completionActions={
          <Link href="/local" className="rounded border border-white/30 p-3">
            Return to local collection
          </Link>
        }
      />
      <ReaderProgressBar page={page} totalPages={archive.pageCount} onSeek={seek} />
    </div>
  );
}
