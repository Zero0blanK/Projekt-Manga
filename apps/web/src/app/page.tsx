import type { Metadata } from 'next';
import { LibraryPageClient } from './client';
import { libraryPreloadScript } from '@/lib/library-preload';

export const metadata: Metadata = {
  title: 'My Library — Projekt Manga',
  description:
    'Your personal manga library. Continue reading, discover new series, and catch the latest chapters.',
  openGraph: {
    title: 'My Library — Projekt Manga',
    description: 'Your personal manga library.',
  },
};

export default function LibraryPage() {
  return (
    <>
      {/* Runs as the HTML arrives: see lib/library-preload.ts. */}
      <script dangerouslySetInnerHTML={{ __html: libraryPreloadScript() }} />
      <LibraryPageClient />
    </>
  );
}
