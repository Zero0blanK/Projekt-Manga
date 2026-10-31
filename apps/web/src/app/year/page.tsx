import type { Metadata } from 'next';
import { YearInMangaClient } from './client';

export const metadata: Metadata = {
  title: 'Your year in manga — Projekt Manga',
  description: 'What you read this year, from your own reading history.',
  robots: { index: false },
};

export default function YearInMangaPage() {
  return <YearInMangaClient />;
}
