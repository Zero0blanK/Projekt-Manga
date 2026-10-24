import type { Metadata } from 'next';
import { Suspense } from 'react';
import { PopularPageClient } from './client';
import { BrowsePageSkeleton } from '@/components/skeletons';

export const metadata: Metadata = {
  title: 'Popular Manga — Projekt Manga',
  description:
    'The most popular manga across all your installed sources, ranked by reader rating and activity.',
  openGraph: {
    title: 'Popular Manga — Projekt Manga',
    description: 'Top-ranked manga from every installed source extension.',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
  },
};

export default function PopularPage() {
  // DiscoverBrowsePage calls useSearchParams(), which bails out of static rendering —
  // needs a boundary above it.
  return (
    <Suspense fallback={<BrowsePageSkeleton />}>
      <PopularPageClient />
    </Suspense>
  );
}
