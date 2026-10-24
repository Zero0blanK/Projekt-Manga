import type { Metadata } from 'next';
import { RecentsPageClient } from './client';

export const metadata: Metadata = {
  title: 'Recents — Projekt Manga',
  description: "Newly updated titles in your library, and what you've been reading.",
};

export default function RecentsPage() {
  return <RecentsPageClient />;
}
