import type { Metadata } from 'next';
import { HistoryPageClient } from './client';

export const metadata: Metadata = {
  title: 'Reading History — Projekt Manga',
  description:
    "Every chapter you've read recently, grouped by day. Pick up exactly where you left off.",
  openGraph: {
    title: 'Reading History — Projekt Manga',
    description: "Every chapter you've read recently.",
  },
};

export default function HistoryPage() {
  return <HistoryPageClient />;
}
