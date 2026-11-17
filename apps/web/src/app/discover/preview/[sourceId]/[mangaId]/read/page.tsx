import { cache } from 'react';
import type { Metadata } from 'next';
import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { SourceReaderClient } from './client';
import { SourceNotInstalled } from '@/components/not-found-page';
import { fetchSourceTitle } from '@/lib/source-title';

type ReadParams = { sourceId: string; mangaId: string };

/** Cached per request: the metadata and the page share one call to the source. */
const fetchDetails = cache(fetchSourceTitle);

export async function generateMetadata({
  params,
}: {
  params: Promise<ReadParams>;
}): Promise<Metadata> {
  const { sourceId, mangaId } = await params;
  const result = await fetchDetails(sourceId, mangaId);
  if (result.status !== 'found') return { title: 'Not found', robots: { index: false } };
  return { title: `Reading ${result.details.title}`, robots: { index: false } };
}

/** Reads a title directly from its source — no library entry required. Chapters and page
 * images both come from the extension rather than the database. */
export default async function SourceReaderPage({ params }: { params: Promise<ReadParams> }) {
  const { sourceId, mangaId } = await params;
  const result = await fetchDetails(sourceId, mangaId);
  if (result.status === 'missing-source') return <SourceNotInstalled />;
  if (result.status === 'missing-title') notFound();

  // useSearchParams() bails out of static rendering, so it needs a boundary above it.
  return (
    <Suspense fallback={null}>
      <SourceReaderClient sourceId={sourceId} details={result.details} />
    </Suspense>
  );
}
