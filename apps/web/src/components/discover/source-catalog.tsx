'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { CircleArrowUp, PackageCheck, PackageOpen, RefreshCw } from 'lucide-react';
import { ApiError } from '@projekt-manga/api-client';
import type { ExtensionListingEntry } from '@projekt-manga/schemas';
import { extensionActions, useSourceCatalog, type CatalogEntry } from '@/lib/extensions-store';
import { Skeleton } from '@/components/ui/skeleton';
import { AddRepositoryForm } from '@/components/extensions/add-repository-form';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { repairSourceName, sourceLanguageGroup, sourceLanguageName } from '@/lib/source-language';
import { toast } from '@/hooks/use-toast';
import { useConfirm } from '@/hooks/use-confirm';
import { repositoryPublisher } from '@/lib/repository-url';
import {
  emptySourceFilters,
  matchesSourceFilters,
  type SourceFiltersValue,
} from './source-filters';
import { useContentPrivacy, isAdultSource } from './content-privacy';

/**
 * Installing and removing sources, on the page where they get used.
 *
 * This sits under the browse grid rather than in Settings so that adding and using a
 * source happen on one screen over one copy of the data. Settings owns only the
 * repository URLs, which really are configuration.
 */

function errorMessage(error: unknown, fallback: string): string {
  // ApiError carries the server's own wording — "already installed from this repository",
  // "needs extension API version 2", "does not match the checksum in its listing" — all of
  // which say more than any message this component could write.
  return error instanceof ApiError ? error.message : fallback;
}

/**
 * The content-rating suffix for a source's detail line.
 *
 * `mixed` is a general catalogue that also carries adult titles: badged, not hidden, which
 * is the whole reason the rating exists alongside the older boolean — that boolean is true
 * only for `nsfw`, so a mixed source read through it alone is indistinguishable from a safe
 * one. `isNSFW` stays the fallback for a listing that predates the rating.
 */
function ratingSuffix(rating: string | null | undefined, isNSFW: boolean): string {
  const effective = rating ?? (isNSFW ? 'nsfw' : null);
  if (effective === 'nsfw') return ' · NSFW';
  if (effective === 'mixed') return ' · Mixed';
  return '';
}

/**
 * A source's icon, or nothing at all.
 *
 * A bare `<img>` rather than `next/image` on purpose. The optimizer only fetches hosts
 * listed in `images.remotePatterns`, and an icon URL here comes from whatever repository
 * the reader added — so making these load through it would mean opening that allowlist wide
 * enough for the server to fetch and re-encode an arbitrary attacker-chosen URL. A plain tag
 * asks the *viewer's* browser instead, the same exposure as any other third-party image, and
 * needs no server-side allowlist.
 *
 * Renders nothing when there is no icon or it fails to load: the repository format makes
 * icons optional and asks for a fallback rather than a broken image.
 */
function SourceIcon({ url }: { url: string | null | undefined }) {
  const [failed, setFailed] = useState(false);
  if (!url || failed) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- see the note above
    <img
      src={url}
      alt=""
      aria-hidden
      width={20}
      height={20}
      loading="lazy"
      onError={() => setFailed(true)}
      className="mt-0.5 size-5 shrink-0 rounded object-contain"
    />
  );
}

function detailLine(entry: ExtensionListingEntry): string {
  return `v${entry.version} · ${sourceLanguageName(entry.lang)}${ratingSuffix(entry.content_rating, entry.isNSFW)}`;
}

export function SourceCatalog({ filters = emptySourceFilters }: { filters?: SourceFiltersValue }) {
  const { repositories, entries, loading, hasNoRepositories } = useSourceCatalog();
  /** Each source row names its publisher, so it needs its repository by id. */
  const repositoryById = new Map(repositories.map((repository) => [repository.id, repository]));
  const [privacy] = useContentPrivacy();
  const { confirm, dialog } = useConfirm();
  const visibleEntries = entries.filter(
    (item) =>
      (!privacy.hideAdult || !isAdultSource(item.entry.content_rating, item.entry.isNSFW)) &&
      matchesSourceFilters(item.entry, item.installedId !== null, filters),
  );
  const [selectedLanguage, setSelectedLanguage] = useState('all');
  const languageGroups = [
    ...new Set(visibleEntries.map((item) => sourceLanguageGroup(item.entry.lang))),
  ].sort((a, b) => sourceLanguageName(a).localeCompare(sourceLanguageName(b)));
  const activeLanguage =
    selectedLanguage === 'all' || languageGroups.includes(selectedLanguage)
      ? selectedLanguage
      : 'all';
  const groups = activeLanguage === 'all' ? languageGroups : [activeLanguage];
  const resultCount = visibleEntries.filter(
    (item) => activeLanguage === 'all' || sourceLanguageGroup(item.entry.lang) === activeLanguage,
  ).length;
  const sections = [
    {
      label: 'Updates',
      Icon: CircleArrowUp,
      matches: (item: CatalogEntry) => item.installedId !== null && item.updateAvailable,
    },
    {
      label: 'Installed',
      Icon: PackageCheck,
      matches: (item: CatalogEntry) => item.installedId !== null && !item.updateAvailable,
    },
    {
      label: 'Available',
      Icon: PackageOpen,
      matches: (item: CatalogEntry) => item.installedId === null,
    },
  ];
  // Keyed per row so one install doesn't disable every other button — a single boolean
  // would freeze the whole list while one source downloads.
  const [busyKeys, setBusyKeys] = useState<Set<string>>(new Set());
  const activeKeys = useRef(new Set<string>());

  const setBusy = (key: string, busy: boolean) =>
    setBusyKeys((prev) => {
      const next = new Set(prev);
      if (busy) next.add(key);
      else next.delete(key);
      return next;
    });

  const run = async (key: string, action: () => Promise<void>) => {
    if (activeKeys.current.has(key)) return;
    activeKeys.current.add(key);
    setBusy(key, true);
    try {
      await action();
    } finally {
      activeKeys.current.delete(key);
      setBusy(key, false);
    }
  };

  const handleInstall = (item: CatalogEntry) =>
    run(`${item.repositoryId}:${item.entry.source_key}`, async () => {
      try {
        await extensionActions.install(item.repositoryId, item.entry.source_key, () =>
          confirm({
            title: 'Install from an unsigned repository?',
            description:
              'This repository does not sign its sources, so nothing verifies who wrote this code. Only install it if you trust the repository.',
            confirmLabel: 'Install anyway',
          }),
        );
        toast({ description: `${repairSourceName(item.entry.name)} installed.` });
      } catch (error) {
        toast({
          description: errorMessage(
            error,
            `Couldn't install ${repairSourceName(item.entry.name)}.`,
          ),
        });
      }
    });

  const handleUninstall = (item: CatalogEntry) =>
    run(`${item.repositoryId}:${item.entry.source_key}`, async () => {
      if (!item.installedId) return;
      try {
        await extensionActions.uninstall(item.installedId);
        toast({ description: `${repairSourceName(item.entry.name)} removed.` });
      } catch (error) {
        toast({
          description: errorMessage(error, `Couldn't remove ${repairSourceName(item.entry.name)}.`),
        });
      }
    });

  const handleUpdate = (item: CatalogEntry) =>
    run(`${item.repositoryId}:${item.entry.source_key}`, async () => {
      if (!item.installedId) return;
      try {
        const changed = await extensionActions.checkForUpdate(item.installedId);
        toast({
          description: changed
            ? `${repairSourceName(item.entry.name)} updated.`
            : `${repairSourceName(item.entry.name)} is up to date.`,
        });
      } catch (error) {
        toast({
          description: errorMessage(error, `Couldn't update ${repairSourceName(item.entry.name)}.`),
        });
      }
    });

  const handleRefreshRepo = (repositoryId: string, label: string) =>
    run(`repo:${repositoryId}`, async () => {
      try {
        await extensionActions.refreshRepository(repositoryId);
        toast({ description: `${label} refreshed.` });
      } catch (error) {
        toast({ description: errorMessage(error, `Couldn't refresh ${label}.`) });
      }
    });

  /**
   * The one refresh for this screen.
   *
   * Every repository is refreshed together because the list below is a single merged view
   * of all of them, so one button covers "refresh what I am looking at".
   */
  const refreshingAll = busyKeys.has('repo:all');
  const handleRefreshAll = () =>
    run('repo:all', async () => {
      const results = await Promise.allSettled(
        repositories.map((repository) => extensionActions.refreshRepository(repository.id)),
      );
      const failed = results.filter((result) => result.status === 'rejected').length;
      toast({
        description:
          failed === 0
            ? `${repositories.length} ${repositories.length === 1 ? 'repository' : 'repositories'} refreshed.`
            : `${failed} of ${repositories.length} could not be refreshed.`,
      });
    });

  if (loading) {
    return (
      <section className="mt-12">
        <h2 className="text-sm font-semibold text-foreground">Extensions</h2>
        <div className="mt-4 space-y-2">
          <Skeleton className="h-16 w-full rounded-xl" />
          <Skeleton className="h-16 w-full rounded-xl" />
        </div>
      </section>
    );
  }

  if (hasNoRepositories) {
    return (
      <section className="mt-12 rounded-2xl border border-dashed border-border/60 p-8 text-center">
        <PackageOpen className="mx-auto h-7 w-7 text-muted-foreground" />
        <h2 className="mt-3 text-sm font-semibold text-foreground">No source repositories yet</h2>
        <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">
          A repository lists the sources you can install. Add one to see them here.
        </p>
        <div className="mt-5">
          <AddRepositoryForm existingUrls={[]} compact />
        </div>
        <p className="mx-auto mt-4 max-w-md text-xs text-muted-foreground">
          Sources run in a restricted process.{' '}
          <Link href="/settings#extensions" className="underline underline-offset-4">
            Manage repositories
          </Link>
        </p>
      </section>
    );
  }

  return (
    <section id="source-catalog" className="mt-12">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-sm font-semibold text-foreground">Extensions</h2>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleRefreshAll}
            disabled={refreshingAll || repositories.length === 0}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border/60 px-2.5 py-1 text-xs font-medium text-foreground transition hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw className={`h-3 w-3 ${refreshingAll ? 'animate-spin' : ''}`} />
            {refreshingAll ? 'Refreshing…' : 'Refresh'}
          </button>
          <Link
            href="/settings#extensions"
            className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            Manage repositories
          </Link>
        </div>
      </div>
      <Tabs value={activeLanguage} onValueChange={setSelectedLanguage} className="mt-4">
        <div className="overflow-x-auto pb-1">
          <TabsList aria-label="Extension languages" className="h-auto min-w-max justify-start">
            <TabsTrigger value="all">
              All <span className="ml-1.5 text-xs opacity-90">{visibleEntries.length}</span>
            </TabsTrigger>
            {languageGroups.map((group) => (
              <TabsTrigger key={group} value={group}>
                {sourceLanguageName(group)}{' '}
                <span className="ml-1.5 text-xs opacity-90">
                  {
                    visibleEntries.filter((item) => sourceLanguageGroup(item.entry.lang) === group)
                      .length
                  }
                </span>
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <TabsContent value={activeLanguage}>
          <p role="status" className="mt-2 text-xs text-muted-foreground">
            {resultCount} catalogue results
          </p>
          {resultCount === 0 && (
            <p className="mt-4 text-sm text-muted-foreground">
              No sources match the current filters.
            </p>
          )}
          <div className="mt-4 space-y-6">
            {sections.map(({ label: sectionLabel, Icon, matches }) => {
              const sectionEntries = visibleEntries.filter(
                (item) =>
                  matches(item) &&
                  (activeLanguage === 'all' ||
                    sourceLanguageGroup(item.entry.lang) === activeLanguage),
              );
              if (!sectionEntries.length) return null;
              return (
                <section
                  key={sectionLabel}
                  aria-label={`${sectionLabel} extensions`}
                  className="space-y-4"
                >
                  <h3 className="flex items-center gap-2 text-base font-semibold text-foreground">
                    <Icon aria-hidden="true" className="size-4 text-primary" />
                    {sectionLabel}
                    <span className="text-xs font-normal text-muted-foreground">
                      {sectionEntries.length}
                    </span>
                  </h3>
                  {groups
                    .filter((group) =>
                      sectionEntries.some((item) => sourceLanguageGroup(item.entry.lang) === group),
                    )
                    .map((group) => (
                      <section
                        key={group}
                        aria-label={`${sourceLanguageName(group)} sources`}
                        className="space-y-3"
                      >
                        <h4 className="text-sm font-semibold text-foreground">
                          {sourceLanguageName(group)}
                        </h4>
                        {(() => {
                          // One flat list per language group rather than a card per
                          // repository: a per-repository header would repeat its name and
                          // Refresh button for every section-and-language combination.
                          // Attribution is shown on each source row instead.
                          const rows = sectionEntries.filter(
                            (item) =>
                              sourceLanguageGroup(item.entry.lang) === group &&
                              !repositoryById.get(item.repositoryId)?.fetchError,
                          );
                          if (!rows.length) return null;
                          return (
                            <ul className="divide-y divide-border/60 overflow-hidden rounded-2xl border border-border/60 bg-surface/40">
                              {rows.map((item) => {
                                const key = `${item.repositoryId}:${item.entry.source_key}`;
                                const busy = busyKeys.has(key);
                                const installed = item.installedId !== null;
                                const repository = repositoryById.get(item.repositoryId);
                                const publisher = repository
                                  ? repositoryPublisher(repository)
                                  : null;

                                return (
                                  <li
                                    key={key}
                                    className="flex items-start justify-between gap-4 px-5 py-3"
                                  >
                                    <div className="flex min-w-0 gap-2.5">
                                      <SourceIcon url={item.entry.icon_url} />
                                      <div className="min-w-0">
                                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                          <span className="max-w-full truncate text-sm font-medium text-foreground">
                                            {repairSourceName(item.entry.name)}
                                          </span>
                                          <span className="text-xs text-muted-foreground">
                                            {detailLine(item.entry)}
                                          </span>
                                          {item.updateAvailable && (
                                            <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                                              Update
                                            </span>
                                          )}
                                        </div>
                                        {publisher && (
                                          <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                                            <span className="truncate">By. {publisher}</span>
                                            {repository?.badge_label && (
                                              <span className="shrink-0 rounded border border-border/60 px-1.5 py-0.5 text-[10px] font-medium">
                                                {repository.badge_label}
                                              </span>
                                            )}
                                          </p>
                                        )}
                                        {item.conflictsWithInstalled && (
                                          <p className="mt-1 text-xs text-muted-foreground">
                                            Another repository already provides{' '}
                                            <span className="text-foreground">
                                              {item.entry.source_key}
                                            </span>
                                            . Remove that one first — two sources cannot share an
                                            id.
                                          </p>
                                        )}
                                      </div>
                                    </div>

                                    <div className="flex shrink-0 items-center gap-2">
                                      {installed && item.updateAvailable && (
                                        <button
                                          onClick={() => handleUpdate(item)}
                                          disabled={busy}
                                          aria-label={`Update ${repairSourceName(item.entry.name)}`}
                                          className="min-h-9 cursor-pointer rounded-lg border border-border/60 px-3 py-1 text-xs font-medium text-foreground transition hover:bg-accent disabled:opacity-50"
                                        >
                                          {busy ? '…' : 'Update'}
                                        </button>
                                      )}
                                      {installed ? (
                                        <button
                                          onClick={() => handleUninstall(item)}
                                          disabled={busy}
                                          aria-label={`Remove ${repairSourceName(item.entry.name)}`}
                                          className="min-h-9 cursor-pointer rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-1 text-xs font-medium text-destructive transition hover:bg-destructive/20 disabled:opacity-50"
                                        >
                                          {busy ? 'Removing…' : 'Remove'}
                                        </button>
                                      ) : (
                                        <button
                                          onClick={() => handleInstall(item)}
                                          disabled={busy || item.conflictsWithInstalled}
                                          aria-label={`Install ${repairSourceName(item.entry.name)}`}
                                          className="min-h-9 cursor-pointer rounded-lg border border-border/60 px-3 py-1 text-xs font-medium text-foreground transition hover:bg-accent disabled:opacity-50"
                                        >
                                          {busy ? 'Installing…' : 'Install'}
                                        </button>
                                      )}
                                    </div>
                                  </li>
                                );
                              })}
                            </ul>
                          );
                        })()}
                      </section>
                    ))}
                </section>
              );
            })}
          </div>
        </TabsContent>
      </Tabs>
      {repositories
        .filter((repository) => repository.fetchError)
        .map((repository) => {
          const label = repository.name || repository.url;
          const busy = busyKeys.has(`repo:${repository.id}`);
          return (
            <div key={repository.id} className="mt-4 rounded-2xl border border-border/60 p-5">
              <div className="flex items-center justify-between gap-3">
                <h3 className="truncate text-sm font-medium">{label}</h3>
                <button
                  type="button"
                  onClick={() => handleRefreshRepo(repository.id, label)}
                  disabled={busy}
                  aria-label={`Refresh ${label}`}
                  className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border/60 px-2.5 py-1 text-xs hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <RefreshCw className={`size-3 ${busy ? 'animate-spin' : ''}`} />
                  Refresh
                </button>
              </div>
              <p className="mt-3 text-sm text-destructive">
                Couldn&apos;t load this repository&apos;s source list: {repository.fetchError}
              </p>
            </div>
          );
        })}
      {dialog}
    </section>
  );
}
