import type { Metadata } from 'next';
import { Suspense } from 'react';
import { LatestPageClient } from './client';
import { BrowsePageSkeleton } from '@/components/skeletons';

export const metadata: Metadata = {
  title: 'Latest — Projekt Manga',
  description: 'The newest titles from a source, newest first.',
  openGraph: {
    title: 'Latest — Projekt Manga',
    description: 'The newest titles from a source, newest first.',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
  },
};

export default function LatestPage() {
  // useSearchParams() bails out of static rendering, so it needs a boundary above it.
  return (
    <Suspense fallback={<BrowsePageSkeleton />}>
      <LatestPageClient />
    </Suspense>
  );
}
