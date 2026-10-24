import type { Metadata } from 'next';
import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { getSourceMangaDetails, ApiError } from '@projekt-manga/api-client';
import { SourceReaderClient } from './client';
import { decodeSourceRouteId } from '@/lib/source-route-id';

type ReadParams = { sourceId: string; mangaId: string };

async function fetchDetails(sourceId: string, mangaId: string) {
  try {
    return await getSourceMangaDetails(sourceId, decodeSourceRouteId(mangaId));
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<ReadParams>;
}): Promise<Metadata> {
  const { sourceId, mangaId } = await params;
  const details = await fetchDetails(sourceId, mangaId);
  if (!details) return { title: 'Not found', robots: { index: false } };
  return { title: `Reading ${details.title}`, robots: { index: false } };
}

/** Reads a title directly from its source — no library entry required. Chapters and page
 * images both come from the extension rather than the database. */
export default async function SourceReaderPage({ params }: { params: Promise<ReadParams> }) {
  const { sourceId, mangaId } = await params;
  const details = await fetchDetails(sourceId, mangaId);
  if (!details) notFound();

  // useSearchParams() bails out of static rendering, so it needs a boundary above it.
  return (
    <Suspense fallback={null}>
      <SourceReaderClient sourceId={sourceId} details={details} />
    </Suspense>
  );
}
