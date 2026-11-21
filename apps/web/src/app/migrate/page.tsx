import type { Metadata } from 'next';
import { BulkMigration } from '@/components/migrate/bulk-migration';
import { BackLink, PageHeader, PageShell } from '@/components/page-shell';

export const metadata: Metadata = {
  title: 'Migrate a source — Projekt Manga',
  robots: { index: false },
};

export default async function BulkMigrationPage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string | string[] }>;
}) {
  const { source } = await searchParams;
  return (
    // PageShell is a <div>: the app layout already provides the page's single <main>.
    <PageShell>
      <PageHeader
        back={<BackLink href="/">Back to library</BackLink>}
        title="Migrate a source"
        description="Move every library title from one source to others and keep what you choose."
      />
      <div className="mt-8">
        <BulkMigration initialSource={typeof source === 'string' ? source : undefined} />
      </div>
    </PageShell>
  );
}
