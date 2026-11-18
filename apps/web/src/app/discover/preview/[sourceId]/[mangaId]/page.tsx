import { cache } from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SourcePreviewClient } from './client';
import { SourceNotInstalled } from '@/components/not-found-page';
import { fetchSourceTitle } from '@/lib/source-title';

type PreviewParams = { sourceId: string; mangaId: string };

/** Reads a title straight from the source, without it being in the library — the
 * catalog item only carries id/title/cover, so full details need this extra call.
 * Cached per request: the metadata and the page share one scrape. */
const fetchPreview = cache(fetchSourceTitle);

export async function generateMetadata({
  params,
}: {
  params: Promise<PreviewParams>;
}): Promise<Metadata> {
  const { sourceId, mangaId } = await params;
  const result = await fetchPreview(sourceId, mangaId);
  if (result.status !== 'found') return { title: 'Not found', robots: { index: false } };
  return {
    title: `${result.details.title} — preview`,
    description: result.details.description?.slice(0, 160),
    robots: { index: false },
  };
}

export default async function SourcePreviewPage({ params }: { params: Promise<PreviewParams> }) {
  const { sourceId, mangaId } = await params;
  const result = await fetchPreview(sourceId, mangaId);
  if (result.status === 'missing-source') return <SourceNotInstalled />;
  if (result.status === 'missing-title') notFound();

  return <SourcePreviewClient sourceId={sourceId} details={result.details} />;
}
