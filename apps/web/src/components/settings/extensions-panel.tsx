'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ApiError } from '@projekt-manga/api-client';
import { Panel, Field } from '@/components/settings/field-controls';
import { AddRepositoryForm } from '@/components/extensions/add-repository-form';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/hooks/use-toast';
import { websiteUrl } from '@/lib/source-url';
import { extensionActions, useExtensionRepositories } from '@/lib/extensions-store';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';

/**
 * Repository URL configuration only: the URLs the app may fetch source code from.
 * Installing individual sources happens in Discover.
 */

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

export function ExtensionsPanel() {
  const { repositories, loading } = useExtensionRepositories();
  // Keyed per repository so one slow refresh doesn't disable every other row's controls.
  const [busyKeys, setBusyKeys] = useState<Set<string>>(new Set());

  const setBusy = (key: string, busy: boolean) =>
    setBusyKeys((prev) => {
      const next = new Set(prev);
      if (busy) next.add(key);
      else next.delete(key);
      return next;
    });

  const handleRefreshRepo = async (id: string, label: string) => {
    setBusy(id, true);
    try {
      await extensionActions.refreshRepository(id);
      toast({ description: `${label} refreshed.` });
    } catch (error) {
      toast({ description: errorMessage(error, "Couldn't refresh that repository.") });
    } finally {
      setBusy(id, false);
    }
  };

  const handleDeleteRepo = async (id: string, label: string) => {
    setBusy(id, true);
    try {
      await extensionActions.removeRepository(id);
      toast({ description: `${label} removed.` });
    } catch (error) {
      toast({ description: errorMessage(error, "Couldn't remove that repository.") });
    } finally {
      setBusy(id, false);
    }
  };

  return (
    <Panel
      title="Extension repositories"
      subtitle="Where the app may fetch manga sources from. Install sources under Discover."
    >
      <div className="rounded-xl border border-border/60 bg-background/40 p-4 text-xs text-muted-foreground">
        A repository can ship real code, which runs in its own restricted process — no access to
        your database, your files outside its own install folder, or your settings, and network
        access limited to the hosts it declares. Only add a repository whose maintainer you trust:
        sandboxing limits the damage a compromised or malicious one can do, but it doesn&apos;t vet
        what the code legitimately does with the network access it&apos;s granted.
      </div>

      <Field label="Add a repository" hint="The URL of a repository's index.json">
        <AddRepositoryForm existingUrls={repositories.map((repo) => repo.url)} />
      </Field>

      {loading ? (
        <div className="space-y-2 border-t border-border/50 pt-5">
          <Skeleton className="h-10 w-full rounded-xl" />
          <Skeleton className="h-10 w-full rounded-xl" />
        </div>
      ) : repositories.length === 0 ? (
        <Field label="Repositories" hint="No repositories added yet">
          <span className="text-xs text-muted-foreground">None</span>
        </Field>
      ) : (
        repositories.map((repo) => {
          const label = repo.name || repo.url;
          const busy = busyKeys.has(repo.id);
          const website = websiteUrl(repo.website);

          return (
            <div key={repo.id} className="border-t border-border/50 pt-5">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground">{label}</span>
                    {repo.badge_label && (
                      <span className="shrink-0 rounded border border-border/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                        {repo.badge_label}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">{repo.url}</div>
                  {repo.description && (
                    <div className="mt-1 text-xs text-muted-foreground">{repo.description}</div>
                  )}
                  {website && (
                    <a
                      href={website}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="mt-1 inline-block text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                    >
                      Repository homepage
                    </a>
                  )}
                  {repo.fetchError ? (
                    <div className="mt-1 text-xs text-destructive">
                      Couldn&apos;t fetch listing: {repo.fetchError}
                    </div>
                  ) : (
                    <div className="mt-1 text-xs text-muted-foreground">
                      {repo.sources.length} {repo.sources.length === 1 ? 'source' : 'sources'}{' '}
                      offered ·{' '}
                      <Link
                        href="/discover"
                        className="underline underline-offset-2 hover:text-foreground"
                      >
                        install from Discover
                      </Link>
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    onClick={() => void handleRefreshRepo(repo.id, label)}
                    disabled={busy}
                    className="rounded-lg border border-border/60 px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-accent disabled:opacity-50"
                  >
                    {busy ? '…' : 'Refresh'}
                  </button>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <button className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs font-medium text-destructive transition hover:bg-destructive/20">
                        Remove
                      </button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Remove this repository?</AlertDialogTitle>
                        <AlertDialogDescription>
                          Every source installed from {label} will be removed too.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={() => void handleDeleteRepo(repo.id, label)}>
                          Remove
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </div>
            </div>
          );
        })
      )}
    </Panel>
  );
}
