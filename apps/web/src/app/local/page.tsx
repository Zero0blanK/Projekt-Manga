import type { Metadata } from 'next';
import { LocalArchiveCollection } from '@/components/reader/local-archive-collection';
import { BackLink, PageHeader, PageShell } from '@/components/page-shell';

export const metadata: Metadata = {
  title: 'Local comics — Projekt Manga',
};

export default function LocalCollectionPage() {
  return (
    <PageShell>
      <PageHeader
        back={<BackLink href="/">Back to library</BackLink>}
        title="Local comics"
        description="Comic files from this computer, read in the desktop app."
      />
      <div className="mt-8">
        <LocalArchiveCollection />
      </div>
    </PageShell>
  );
}
