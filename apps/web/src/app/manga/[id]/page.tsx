import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getRequestManga } from '@/lib/server-manga';
import { MangaDetailLayout } from '@/components/manga-detail/detail-layout';
import { MangaActionBar } from '@/components/manga-detail/action-bar';
import { ChapterList } from '@/components/manga-detail/chapter-list';
import { SimilarTitles } from '@/components/manga-detail/similar-titles';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const manga = await getRequestManga(id);
  if (!manga) return { title: 'Not found', robots: { index: false } };
  return {
    title: `${manga.title} — Projekt Manga`,
    description: manga.synopsis,
    openGraph: {
      title: `${manga.title} — Projekt Manga`,
      description: manga.synopsis,
    },
  };
}

export default async function MangaDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const manga = await getRequestManga(id);
  if (!manga) notFound();

  return (
    <MangaDetailLayout
      manga={manga}
      backHref="/"
      backLabel="library"
      actions={<MangaActionBar manga={manga} />}
    >
      <ChapterList manga={manga} />
      <SimilarTitles manga={manga} />
    </MangaDetailLayout>
  );
}
