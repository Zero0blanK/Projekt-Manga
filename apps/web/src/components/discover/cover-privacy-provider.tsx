'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useInstalledExtensions } from '@/lib/extensions-store';
import { useMangaLibrary, useSources } from '@/lib/library-store';
import { isAdultSource, useContentPrivacy } from './content-privacy';

const CoverPrivacy = createContext({ sources: new Set<string>(), manga: new Set<string>() });

export function CoverPrivacyProvider({ children }: { children: ReactNode }) {
  const [privacy] = useContentPrivacy();
  const { installed } = useInstalledExtensions();
  const { sources } = useSources();
  const { manga } = useMangaLibrary();
  const blurredSources = useMemo(() => {
    const ids = new Set<string>();
    if (!privacy.blurAdult) return { sources: ids, manga: new Set<string>() };
    for (const source of sources) {
      const extension = installed.find((item) => item.source_key === source.id);
      if (extension ? isAdultSource(extension.content_rating, extension.is_nsfw) : source.isNSFW)
        ids.add(source.id);
    }
    return {
      sources: ids,
      manga: new Set(manga.filter((item) => ids.has(item.source)).map((item) => item.id)),
    };
  }, [privacy.blurAdult, installed, sources, manga]);
  return <CoverPrivacy.Provider value={blurredSources}>{children}</CoverPrivacy.Provider>;
}

export function useCoverBlur(sourceId?: string, mangaId?: string): boolean {
  const policy = useContext(CoverPrivacy);
  return (!!sourceId && policy.sources.has(sourceId)) || (!!mangaId && policy.manga.has(mangaId));
}
