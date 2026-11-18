'use client';

import { useSources } from '@/lib/library-store';

/** A source's name as installed ("MangaGeko"), or its id until the list has loaded. */
export function SourceName({ sourceId }: { sourceId: string }) {
  const { sources } = useSources();
  return <>{sources.find((source) => source.id === sourceId)?.name ?? sourceId}</>;
}
