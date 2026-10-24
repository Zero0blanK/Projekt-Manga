import type { Metadata } from 'next';
import { DownloadsPageClient } from './client';

export const metadata: Metadata = {
  title: 'Downloads — Projekt Manga',
  description: 'Manage offline chapters, monitor active downloads, and free up storage.',
  openGraph: {
    title: 'Downloads — Projekt Manga',
    description: 'Manage offline chapters and storage.',
  },
};

export default function DownloadsPage() {
  return <DownloadsPageClient />;
}
