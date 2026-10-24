import type { Metadata } from 'next';
import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { getRequestManga } from '@/lib/server-manga';
import { ReaderPageClient } from './client';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const manga = await getRequestManga(id);
  if (!manga) return { title: 'Not found', robots: { index: false } };
  return {
    title: `Reading ${manga.title} — Projekt Manga`,
    description: `Reading ${manga.title}`,
    robots: { index: false },
  };
}

export default async function ReaderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const manga = await getRequestManga(id);
  if (!manga) notFound();

  // useSearchParams() bails out of static rendering, so it needs a boundary above it.
  return (
    <Suspense fallback={null}>
      <ReaderPageClient manga={manga} />
    </Suspense>
  );
}
