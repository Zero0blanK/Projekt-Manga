'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Layers } from 'lucide-react';
import { getMangaChapters, getMangaLinks } from '@projekt-manga/api-client';
import { useSources } from '@/lib/library-store';
import { isLinkGroup } from '@/components/manga-detail/linked-sources';

type Offer = { href: string; number: number; source: string };

/**
 * When the title being read can't go on (this chapter won't load, or it has no next
 * chapter), offers the same or the next chapter from one of its linked sources, tried in
 * their order. Reading continues in that source's own reader, so its progress and history
 * are recorded where the chapter actually came from.
 */
export function LinkedSourceFallback({
  mangaId,
  chapterNumber,
  need,
}: {
  mangaId: string;
  chapterNumber: number;
  /** 'same': this chapter failed to load. 'next': there is no next chapter here. */
  need: 'same' | 'next' | null;
}) {
  const { sources } = useSources();
  const [offer, setOffer] = useState<Offer | null>(null);

  useEffect(() => {
    setOffer(null);
    if (!need) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const group = await getMangaLinks(mangaId, controller.signal);
        // Only from the library entry's own reader: a linked title's reader offers nothing.
        if (!isLinkGroup(group) || group.primary_id !== mangaId) return;
        for (const { linked } of group.links) {
          let chapters;
          try {
            chapters = await getMangaChapters(
              linked.id,
              linked.slug,
              linked.source,
              controller.signal,
            );
          } catch {
            continue;
          }
          const match =
            need === 'same'
              ? chapters.find((chapter) => chapter.chapter_number === chapterNumber)
              : chapters
                  .filter((chapter) => chapter.chapter_number > chapterNumber)
                  .sort((a, b) => a.chapter_number - b.chapter_number)[0];
          if (match) {
            if (!controller.signal.aborted)
              setOffer({
                href: `/reader/${encodeURIComponent(linked.id)}?ch=${match.chapter_number}&chapterId=${encodeURIComponent(match.id)}`,
                number: match.chapter_number,
                source: linked.source,
              });
            return;
          }
        }
      } catch {
        /* nothing to offer */
      }
    })();
    return () => controller.abort();
  }, [mangaId, chapterNumber, need]);

  if (!need || !offer) return null;
  const name = sources.find((source) => source.id === offer.source)?.name ?? offer.source;
  return (
    <div
      role="status"
      className="fixed inset-x-0 bottom-24 z-40 mx-auto flex w-fit max-w-[90vw] items-center gap-3 rounded-full border border-white/15 bg-black/85 px-4 py-2 text-sm text-white shadow-lg backdrop-blur"
    >
      <Layers size={16} aria-hidden />
      <span>
        {need === 'same' ? "This chapter won't load here." : 'No next chapter on this source.'}
      </span>
      <Link
        href={offer.href}
        className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-black"
      >
        Read Chapter {offer.number} on {name}
      </Link>
    </div>
  );
}
