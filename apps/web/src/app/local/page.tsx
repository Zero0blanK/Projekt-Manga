import type { Metadata } from 'next';
import { LocalArchiveCollection } from '@/components/reader/local-archive-collection';

export const metadata: Metadata = {
  title: 'Local comics — Projekt Manga',
};

export default function LocalCollectionPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-6 px-4 py-8">
      <h1 className="text-2xl font-semibold">Local comics</h1>
      <LocalArchiveCollection />
    </div>
  );
}
