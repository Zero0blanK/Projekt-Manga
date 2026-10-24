import Link from 'next/link';
import { PackageOpen, ArrowRight } from 'lucide-react';

/**
 * What Discover's *search* results show when no source is installed.
 *
 * Searching is the one place that can be reached with nothing installed and nothing useful
 * to offer — the unsearched view puts the installable-source catalog on screen instead
 * (`source-catalog.tsx`), which explains the model and lets the reader act on it in the
 * same breath. This is the pointer back to that.
 *
 * The link drops the `?q=` rather than going to Settings: sources are installed on
 * Discover, and Settings only holds the repository URLs.
 */
export function NoSourcesEmptyState() {
  return (
    <div className="mt-12 rounded-2xl border border-dashed border-border/60 p-12 text-center">
      <PackageOpen className="mx-auto h-8 w-8 text-muted-foreground" />
      <p className="mt-3 text-sm text-muted-foreground">
        No sources installed, so there is nothing to search yet.
      </p>
      <Link
        href="/discover?tab=extensions"
        className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-foreground underline-offset-4 hover:underline"
      >
        Install a source <ArrowRight className="h-3.5 w-3.5" />
      </Link>
    </div>
  );
}
