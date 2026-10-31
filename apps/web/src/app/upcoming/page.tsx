import type { Metadata } from 'next';
import { UpcomingPageClient } from './client';

export const metadata: Metadata = {
  title: 'Upcoming — Projekt Manga',
  description: 'When the next chapters of your library are expected.',
  openGraph: {
    title: 'Upcoming — Projekt Manga',
    description: 'When the next chapters of your library are expected.',
  },
};

export default function UpcomingPage() {
  return <UpcomingPageClient />;
}
