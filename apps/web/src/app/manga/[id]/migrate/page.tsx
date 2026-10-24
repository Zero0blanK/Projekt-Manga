import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ArrowRightLeft } from 'lucide-react';
import { getRequestManga } from '@/lib/server-manga';
import { SourceMigration } from '@/components/manga-detail/source-switch';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const manga = await getRequestManga(id);
  if (!manga) return { title: 'Not found', robots: { index: false } };
  return { title: `Migrate ${manga.title} — Projekt Manga`, robots: { index: false } };
}

export default async function MigrationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const manga = await getRequestManga(id);
  if (!manga) notFound();
  return (
    // A <div>: the app layout already provides the page's single <main> landmark.
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-8">
      <Link
        href={`/manga/${encodeURIComponent(id)}`}
        title={`Back to ${manga.title}`}
        className="inline-flex max-w-full items-center gap-2 text-sm text-muted-foreground hover:text-primary"
      >
        <ArrowLeft size={16} className="shrink-0" />
        <span className="min-w-0 truncate">Back to {manga.title}</span>
      </Link>
      <div className="mb-7 mt-5 flex items-start gap-3">
        <span className="mt-1 grid size-10 shrink-0 place-items-center rounded-xl bg-primary/15 text-primary">
          <ArrowRightLeft size={20} aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Migrate manga</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Move this title to another source and keep what you choose.
          </p>
        </div>
      </div>
      <SourceMigration manga={manga} />
    </div>
  );
}
