'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { CircleArrowUp, PackageCheck, PackageOpen, RefreshCw } from 'lucide-react';
import { buildInstalledExtensionIconUrl, type SuwayomiExtension } from '@projekt-manga/api-client';
import { describeLoadError } from '@/lib/load-error';
import type { ExtensionListingEntry } from '@projekt-manga/schemas';
import { extensionActions, useSourceCatalog, type CatalogEntry } from '@/lib/extensions-store';
import { Skeleton } from '@/components/ui/skeleton';
import { AddRepositoryForm } from '@/components/extensions/add-repository-form';
import { repairSourceName, sourceLanguageGroup, sourceLanguageName } from '@/lib/source-language';
import { compareLanguageGroups, type DiscoverFilters } from '@/lib/discover-filters';
import { toast } from '@/hooks/use-toast';
import { useUnsignedInstallConfirm } from '@/hooks/use-unsigned-install-confirm';
import { repositoryAuthor } from '@/lib/repository-url';
import {
  ENGINE_AUTHOR,
  matchesEngineFilters,
  useEngineExtensionActions,
  useSuwayomiExtensions,
} from '@/lib/engine-extensions';
import { EngineStatusNotice, ExtensionIcon, GrowingList } from './suwayomi-extensions';
import {
  emptySourceFilters,
  matchesSourceFilters,
  type SourceFiltersValue,
} from './source-filters';
import { useContentPrivacy, isAdultSource } from './content-privacy';
import { sourceIconUrl } from '@/lib/source-url';
import { CachedSourceIcon } from './cached-source-icon';

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
  // which say more than any message this component could write. It follows what failed,
  // so a bare server error still says which source and which action.
  // An ended sign-in or a bare server status is put in words (lib/load-error.ts).
  const detail = describeLoadError(error);
  return detail ? `${fallback.replace(/\.$/, '')}: ${detail}` : fallback;
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
 * Not `next/image`: the optimizer only fetches hosts listed in `images.remotePatterns`, and
 * an icon URL here comes from whatever repository the reader added. An installed source's
 * icon comes from the copy stored with it, which may be an SVG; any other goes through the
 * guarded image proxy, which refuses SVGs. Either way the icon is kept in this browser
 * (CachedSourceIcon), so it shows at once on the next visit and survives a failed load.
 *
 * Renders nothing when there is no icon: the repository format makes icons optional and
 * asks for a fallback rather than a broken image.
 */
function SourceIcon({
  sourceKey,
  url,
  installedId,
}: {
  sourceKey: string;
  url: string | null | undefined;
  /** The installed copy's id, whose stored icon can be served even when it is an SVG. */
  installedId: string | null;
}) {
  return (
    <CachedSourceIcon
      cacheKey={sourceKey}
      url={installedId ? buildInstalledExtensionIconUrl(installedId) : sourceIconUrl(url)}
      size={20}
      className="mt-0.5 size-5 shrink-0 rounded object-contain"
      fallback={null}
    />
  );
}

function detailLine(entry: ExtensionListingEntry): string {
  return `v${entry.version} · ${sourceLanguageName(entry.lang)}${ratingSuffix(entry.content_rating, entry.isNSFW)}`;
}

/** Where a row sits on the page: Updates, Installed or Available. */
type SectionLabel = 'Updates' | 'Installed' | 'Available';

/**
 * One row of the merged list: a source from an extension repository, or an extension from
 * the extension engine. They differ only in who made them and how they install.
 */
type CatalogRow =
  | { kind: 'repository'; key: string; name: string; lang: string; item: CatalogEntry }
  | { kind: 'engine'; key: string; name: string; lang: string; extension: SuwayomiExtension };

function sectionOf(row: CatalogRow): SectionLabel {
  if (row.kind === 'repository') {
    if (row.item.installedId === null) return 'Available';
    return row.item.updateAvailable ? 'Updates' : 'Installed';
  }
  if (!row.extension.installed) return 'Available';
  return row.extension.has_update ? 'Updates' : 'Installed';
}

const SECTIONS: Array<{ label: SectionLabel; Icon: typeof PackageOpen }> = [
  { label: 'Updates', Icon: CircleArrowUp },
  { label: 'Installed', Icon: PackageCheck },
  { label: 'Available', Icon: PackageOpen },
];

const ROW_LIST_CLASS =
  'divide-y divide-border/60 overflow-hidden rounded-2xl border border-border/60 bg-surface/40';

/**
 * Discover › Extensions: every source that can be installed, from the extension
 * repositories and from the extension engine, in one list. Updates, Installed and
 * Available each hold both, by language, and each row says who made it.
 */
export function SourceCatalog({
  filters = emptySourceFilters,
  language = '',
  repositoryId = null,
  showRepositories = true,
  showEngine = false,
}: {
  filters?: SourceFiltersValue;
  /** A language group from Discover's filter bar, or '' for every language. */
  language?: string;
  /** Only this repository's sources, or null for every repository. */
  repositoryId?: string | null;
  /** The extension repositories' sources (off when the filter picks the engine alone). */
  showRepositories?: boolean;
  /** The extension engine's extensions, when there is an engine this reader may manage. */
  showEngine?: boolean;
}) {
  const { repositories, entries, loading, hasNoRepositories } = useSourceCatalog();
  const engine = useSuwayomiExtensions(showEngine);
  const engineActions = useEngineExtensionActions();
  const withEngine = showEngine && engine.enabled;
  /** Each source row names its author, so it needs its repository by id. */
  const repositoryById = new Map(repositories.map((repository) => [repository.id, repository]));
  const [privacy] = useContentPrivacy();
  const { confirmUnsigned, dialog } = useUnsignedInstallConfirm();
  const activeLanguage = language || 'all';
  const inLanguage = (lang: string) =>
    activeLanguage === 'all' || sourceLanguageGroup(lang) === activeLanguage;
  const visibleEntries = showRepositories
    ? entries.filter(
        (item) =>
          (!privacy.hideAdult || !isAdultSource(item.entry.content_rating, item.entry.isNSFW)) &&
          matchesSourceFilters(item.entry, item.installedId !== null, filters) &&
          (!repositoryId || item.repositoryId === repositoryId) &&
          // A repository that failed to load is reported below the list instead.
          !repositoryById.get(item.repositoryId)?.fetchError,
      )
    : [];
  const engineExtensions = withEngine
    ? (engine.list.data ?? []).filter((extension) =>
        matchesEngineFilters(
          extension,
          filters.name,
          // Language is applied to every row below. The engine has no "mixed" rating, so
          // that filter matches none of its extensions.
          { language: '', rating: filters.rating as DiscoverFilters['rating'] },
          privacy.hideAdult,
        ),
      )
    : [];
  const rows: CatalogRow[] = [
    ...visibleEntries.map((item): CatalogRow => ({
      kind: 'repository',
      key: `${item.repositoryId}:${item.entry.source_key}`,
      name: repairSourceName(item.entry.name),
      lang: item.entry.lang,
      item,
    })),
    ...engineExtensions.map((extension): CatalogRow => ({
      kind: 'engine',
      key: `engine:${extension.pkg_name}`,
      name: extension.name,
      lang: extension.lang,
      extension,
    })),
  ]
    .filter((row) => inLanguage(row.lang))
    .sort((a, b) => a.name.localeCompare(b.name));
  const resultCount = rows.length;
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

  // Which action a row is busy with, so its label says that one. A finished install turns
  // the row's button into "Remove" while the list refreshes, and a plain busy flag then made
  // it read "Removing…".
  const [rowActions, setRowActions] = useState<Record<string, 'install' | 'remove' | 'update'>>({});
  const runRow = (
    key: string,
    kind: 'install' | 'remove' | 'update',
    action: () => Promise<void>,
  ) => {
    if (activeKeys.current.has(key)) return Promise.resolve();
    setRowActions((prev) => ({ ...prev, [key]: kind }));
    return run(key, action).finally(() =>
      setRowActions((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      }),
    );
  };

  const handleInstall = (item: CatalogEntry) =>
    runRow(`${item.repositoryId}:${item.entry.source_key}`, 'install', async () => {
      try {
        await extensionActions.install(item.repositoryId, item.entry.source_key, confirmUnsigned);
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
    runRow(`${item.repositoryId}:${item.entry.source_key}`, 'remove', async () => {
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
    runRow(`${item.repositoryId}:${item.entry.source_key}`, 'update', async () => {
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
      const lists = [
        ...repositories.map(
          (repository) => () => extensionActions.refreshRepository(repository.id),
        ),
        ...(withEngine ? [engineActions.refresh] : []),
      ];
      const results = await Promise.allSettled(lists.map((refresh) => refresh()));
      const failed = results.filter((result) => result.status === 'rejected').length;
      toast({
        description:
          failed === 0
            ? `${lists.length} ${lists.length === 1 ? 'list' : 'lists'} refreshed.`
            : `${failed} of ${lists.length} could not be refreshed.`,
      });
    });

  /** The install, update and remove buttons of one row, whichever list it came from. */
  const rowActionsFor = (row: CatalogRow) => {
    const buttonClass =
      'min-h-9 cursor-pointer rounded-lg border border-border/60 px-3 py-1 text-xs font-medium text-foreground transition hover:bg-accent disabled:opacity-50';
    const removeClass =
      'min-h-9 cursor-pointer rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-1 text-xs font-medium text-destructive transition hover:bg-destructive/20 disabled:opacity-50';
    if (row.kind === 'engine') {
      const { extension } = row;
      const busy = engineActions.busy.has(extension.pkg_name);
      return (
        <>
          {extension.installed && extension.has_update && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void engineActions.change(extension, 'update')}
              aria-label={`Update ${row.name}`}
              className={buttonClass}
            >
              {busy ? '…' : 'Update'}
            </button>
          )}
          {extension.installed ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void engineActions.change(extension, 'uninstall')}
              aria-label={`Remove ${row.name}`}
              className={removeClass}
            >
              {busy ? 'Removing…' : 'Remove'}
            </button>
          ) : (
            <button
              type="button"
              disabled={busy || extension.obsolete}
              onClick={() => void engineActions.change(extension, 'install')}
              aria-label={`Install ${row.name}`}
              className={buttonClass}
            >
              {busy ? 'Installing…' : 'Install'}
            </button>
          )}
        </>
      );
    }
    const { item, key } = row;
    const busy = busyKeys.has(key);
    return (
      <>
        {item.installedId !== null && item.updateAvailable && (
          <button
            type="button"
            onClick={() => handleUpdate(item)}
            disabled={busy}
            aria-label={`Update ${row.name}`}
            className={buttonClass}
          >
            {busy ? '…' : 'Update'}
          </button>
        )}
        {item.installedId !== null ? (
          <button
            type="button"
            onClick={() => handleUninstall(item)}
            disabled={busy}
            aria-label={`Remove ${row.name}`}
            className={removeClass}
          >
            {rowActions[key] === 'remove' ? 'Removing…' : 'Remove'}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => handleInstall(item)}
            disabled={busy || item.conflictsWithInstalled}
            aria-label={`Install ${row.name}`}
            className={buttonClass}
          >
            {rowActions[key] === 'install' ? 'Installing…' : 'Install'}
          </button>
        )}
      </>
    );
  };

  const renderRow = (row: CatalogRow) => {
    const repository = row.kind === 'repository' ? repositoryById.get(row.item.repositoryId) : null;
    const author =
      row.kind === 'engine' ? ENGINE_AUTHOR : repository ? repositoryAuthor(repository) : null;
    const updateAvailable =
      row.kind === 'engine'
        ? row.extension.installed && row.extension.has_update
        : row.item.updateAvailable;
    const detail =
      row.kind === 'engine'
        ? `v${row.extension.version} · ${sourceLanguageName(row.extension.lang)}${row.extension.is_nsfw ? ' · NSFW' : ''}${row.extension.obsolete ? ' · Obsolete' : ''}`
        : detailLine(row.item.entry);
    return (
      <li key={row.key} className="flex items-start justify-between gap-4 px-5 py-3">
        <div className="flex min-w-0 gap-2.5">
          {row.kind === 'engine' ? (
            <ExtensionIcon url={row.extension.icon_url} />
          ) : (
            <SourceIcon
              sourceKey={row.item.entry.source_key}
              url={row.item.entry.icon_url}
              installedId={row.item.installedId}
            />
          )}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="max-w-full truncate text-sm font-medium text-foreground">
                {row.name}
              </span>
              <span className="text-xs text-muted-foreground">{detail}</span>
              {updateAvailable && (
                <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                  Update
                </span>
              )}
            </div>
            {author && (
              <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                <span className="truncate">{author}</span>
                {repository?.badge_label && (
                  <span className="shrink-0 rounded border border-border/60 px-1.5 py-0.5 text-[10px] font-medium">
                    {repository.badge_label}
                  </span>
                )}
              </p>
            )}
            {row.kind === 'repository' && row.item.conflictsWithInstalled && (
              <p className="mt-1 text-xs text-muted-foreground">
                Another repository already provides{' '}
                <span className="text-foreground">{row.item.entry.source_key}</span>. Remove that
                one first — two sources cannot share an id.
              </p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">{rowActionsFor(row)}</div>
      </li>
    );
  };

  if (loading && !withEngine) {
    return (
      <section className="mt-12">
        <h2 className="text-sm font-semibold text-foreground">Available sources</h2>
        <div className="mt-4 space-y-2">
          <Skeleton className="h-16 w-full rounded-xl" />
          <Skeleton className="h-16 w-full rounded-xl" />
        </div>
      </section>
    );
  }

  if (hasNoRepositories && !withEngine) {
    return (
      <section className="mt-12 rounded-2xl border border-dashed border-border/60 p-8 text-center">
        <PackageOpen className="mx-auto h-7 w-7 text-muted-foreground" />
        <h2 className="mt-3 text-sm font-semibold text-foreground">No source repositories yet</h2>
        <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">
          A repository lists the sources you can install. Add one to see them here.
        </p>
        <div className="mt-5">
          <AddRepositoryForm compact />
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
        <h2 className="text-sm font-semibold text-foreground">Available sources</h2>
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
      <div className="mt-4">
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          {resultCount} catalog results
        </p>
        {withEngine && !engine.list.data?.length && (
          <div className="mt-4">
            <EngineStatusNotice builtIn={engine.builtIn} list={engine.list} />
          </div>
        )}
        {loading && showRepositories && (
          <div className="mt-4 space-y-2">
            <Skeleton className="h-16 w-full rounded-xl" />
            <Skeleton className="h-16 w-full rounded-xl" />
          </div>
        )}
        {resultCount === 0 && !loading && (
          <p className="mt-4 text-sm text-muted-foreground">
            No sources match the current filters.
          </p>
        )}
        <div className="mt-4 space-y-6">
          {SECTIONS.map(({ label: sectionLabel, Icon }) => {
            const sectionRows = rows.filter((row) => sectionOf(row) === sectionLabel);
            if (!sectionRows.length) return null;
            const languageGroups = [
              ...new Set(sectionRows.map((row) => sourceLanguageGroup(row.lang))),
            ].sort(compareLanguageGroups);
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
                    {sectionRows.length}
                  </span>
                </h3>
                {languageGroups.map((group) => (
                  <section
                    key={group}
                    aria-label={`${sourceLanguageName(group)} sources`}
                    className="space-y-3"
                  >
                    <h4 className="text-sm font-semibold text-foreground">
                      {sourceLanguageName(group)}
                    </h4>
                    {/* One list per language, whoever made the sources: each row says who
                        did. The engine can list over a thousand, so rows are added as the
                        end of the list nears the screen. */}
                    <GrowingList
                      rows={sectionRows.filter((row) => sourceLanguageGroup(row.lang) === group)}
                      className={ROW_LIST_CLASS}
                      render={renderRow}
                    />
                  </section>
                ))}
              </section>
            );
          })}
        </div>
      </div>
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
