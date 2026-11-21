import type { Metadata } from 'next';
import { LibraryPageClient } from './client';

export const metadata: Metadata = {
  title: 'My Library — Projekt Manga',
  description:
    'Your personal manga library. Continue reading, discover new series, and catch the latest chapters.',
  openGraph: {
    title: 'My Library — Projekt Manga',
    description: 'Your personal manga library.',
  },
};

// The library's first page starts downloading from the root layout: see lib/library-preload.ts.
export default function LibraryPage() {
  return <LibraryPageClient />;
}
