import type { Metadata } from 'next';
import { BookmarksPageClient } from './client';

export const metadata: Metadata = {
  title: 'Bookmarks — Projekt Manga',
  description: "The titles you've bookmarked to come back to later.",
  openGraph: {
    title: 'Bookmarks — Projekt Manga',
    description: 'Your bookmarked manga.',
  },
};

export default function BookmarksPage() {
  return <BookmarksPageClient />;
}
