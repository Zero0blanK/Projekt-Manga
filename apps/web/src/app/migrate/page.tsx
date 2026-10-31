import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft, ArrowRightLeft } from 'lucide-react';
import { BulkMigration } from '@/components/migrate/bulk-migration';

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
    // A <div>: the app layout already provides the page's single <main> landmark.
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-8">
      <Link
        href="/"
        className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-primary"
      >
        <ArrowLeft size={16} className="shrink-0" />
        Back to library
      </Link>
      <div className="mb-7 mt-5 flex items-start gap-3">
        <span className="mt-1 grid size-10 shrink-0 place-items-center rounded-xl bg-primary/15 text-primary">
          <ArrowRightLeft size={20} aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Migrate a source</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Move every library title from one source to others and keep what you choose.
          </p>
        </div>
      </div>
      <BulkMigration initialSource={typeof source === 'string' ? source : undefined} />
    </div>
  );
}
