import type { Metadata } from 'next';
import { Suspense } from 'react';
import { DiscoverPageClient } from './client';
import { SourceCardsSkeleton } from '@/components/skeletons';
import { Skeleton } from '@/components/ui/skeleton';

export const metadata: Metadata = {
  title: 'Browse Sources — Projekt Manga',
  description:
    'Browse manga through your installed source extensions — MangaDex, KissManga, MangaGeko and more — with popular and latest feeds per source.',
  openGraph: {
    title: 'Browse Sources — Projekt Manga',
    description: 'Popular and latest titles from each installed extension.',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
  },
};

export default function DiscoverPage() {
  // useSearchParams() bails out of static rendering, so it needs a boundary above it.
  return (
    <Suspense
      fallback={
        <div className="min-w-0 px-8 py-6">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="mt-3 h-9 w-64" />
          <div className="mt-8">
            <SourceCardsSkeleton />
          </div>
        </div>
      }
    >
      <DiscoverPageClient />
    </Suspense>
  );
}
