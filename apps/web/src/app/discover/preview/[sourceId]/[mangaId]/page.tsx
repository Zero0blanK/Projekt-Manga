import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getSourceMangaDetails, ApiError } from '@projekt-manga/api-client';
import type { MangaDetails } from '@projekt-manga/types';
import { SourcePreviewClient } from './client';
import { decodeSourceRouteId } from '@/lib/source-route-id';

type PreviewParams = { sourceId: string; mangaId: string };

/** Reads a title straight from the source, without it being in the library — the
 * catalog item only carries id/title/cover, so full details need this extra call. */
async function fetchPreview(sourceId: string, mangaId: string): Promise<MangaDetails | null> {
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
  params: Promise<PreviewParams>;
}): Promise<Metadata> {
  const { sourceId, mangaId } = await params;
  const details = await fetchPreview(sourceId, mangaId);
  if (!details) return { title: 'Not found', robots: { index: false } };
  return {
    title: `${details.title} — preview`,
    description: details.description?.slice(0, 160),
    robots: { index: false },
  };
}

export default async function SourcePreviewPage({ params }: { params: Promise<PreviewParams> }) {
  const { sourceId, mangaId } = await params;
  const details = await fetchPreview(sourceId, mangaId);
  if (!details) notFound();

  return <SourcePreviewClient sourceId={sourceId} details={details} />;
}
