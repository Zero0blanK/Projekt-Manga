'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getSourceHealth } from '@projekt-manga/api-client';
import { installedExtensionsByKey } from '@projekt-manga/types';
import { queryClient } from '@/lib/query-client';
import { useSources } from '@/lib/library-store';
import { useInstalledExtensions, useSourceCatalog } from '@/lib/extensions-store';
import {
  sourceLanguageEditions,
  sourceLanguageGroup,
  sourceLanguageName,
} from '@/lib/source-language';
import { EMPTY_IDS, parseIdList, useProfilePreference } from '@/lib/profile-preferences';
import { useCurrentUser } from '@/lib/session-resource';
import { useContentPrivacy, isAdultSource } from '@/components/discover/content-privacy';
import { emptySourceFilters } from '@/components/discover/source-filters';
import { toDisplaySource } from '@/lib/manga-data';
import { SourceSearchCarousel } from '@/components/discover/source-search-carousel';
import { SourceCardsSkeleton } from '@/components/skeletons';
import { NoSourcesEmptyState } from '@/components/discover/no-sources-empty-state';
import { SourceCatalog } from '@/components/discover/source-catalog';
import {
  SuwayomiExtensions,
  useSuwayomiExtensions,
} from '@/components/discover/suwayomi-extensions';
import { InstalledSourceCard } from '@/components/discover/installed-source-card';
import { SourceBulkBar } from '@/components/discover/source-bulk-bar';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Pin, Puzzle, Search, X } from 'lucide-react';
import type { DisplaySource } from '@/lib/manga-data';
import { DiscoverFilterBar } from '@/components/discover/discover-filter-bar';
import {
  EMPTY_DISCOVER_FILTERS,
  SUWAYOMI_ORIGIN,
  compareLanguageGroups,
  originRepositoryId,
  readDiscoverFilters,
  repositoryOrigin,
  writeDiscoverFilters,
  type DiscoverFilters,
} from '@/lib/discover-filters';
import { summarizeSourceHealth } from '@/lib/source-health-status';
import { repositoryPublisher } from '@/lib/repository-url';

/** The Extensions tab's filters in the URL, apart from Installed sources' own. */
const EXTENSION_FILTER_PREFIX = 'x';

export function DiscoverPageClient() {
  const params = useSearchParams(),
    query = params.get('q')?.trim() ?? '';
  const { sources: apiSources, loading } = useSources();
  const { installed } = useInstalledExtensions();
  const { entries: catalogueEntries = [], repositories = [] } = useSourceCatalog();
  const suwayomi = useSuwayomiExtensions();
  const allSources = apiSources.map(toDisplaySource);
  const installedByKey = installedExtensionsByKey(installed);
  const [privacy] = useContentPrivacy();
  const [pins, setPins] = useProfilePreference('pinnedSources', parseIdList, EMPTY_IDS);
  const [incognito, setIncognito] = useProfilePreference(
    'incognitoSources',
    parseIdList,
    EMPTY_IDS,
  );
  const [name, setName] = useState('');
  // Null until "Select sources" is on; then the ticked source ids.
  const [picked, setPicked] = useState<string[] | null>(null);
  // Kept in the URL too, so Back from a source returns to the same filtered list.
  const [filters, setFilters] = useState<DiscoverFilters>(() => readDiscoverFilters(params));
  const [extensionFilters, setExtensionFilters] = useState<DiscoverFilters>(() =>
    readDiscoverFilters(params, EXTENSION_FILTER_PREFIX),
  );
  const [tab, setTab] = useState(params.get('tab') === 'extensions' ? 'extensions' : 'installed');
  const requestedTab = params.get('tab');
  useEffect(() => {
    if (requestedTab === 'extensions' || requestedTab === 'installed') setTab(requestedTab);
  }, [requestedTab]);
  const router = useRouter();
  // The tab lives in the URL too, so Back from a source returns to the tab it was opened from.
  const changeTab = (next: string) => {
    setTab(next);
    const search = new URLSearchParams(params.toString());
    if (next === 'extensions') search.set('tab', 'extensions');
    else search.delete('tab');
    const query = search.toString();
    router.replace(query ? `?${query}` : '?', { scroll: false });
  };
  const keepFilters = (next: DiscoverFilters, prefix = '') => {
    const search = new URLSearchParams(window.location.search);
    writeDiscoverFilters(search, next, prefix);
    const query = search.toString();
    router.replace(query ? `?${query}` : '?', { scroll: false });
  };
  const changeFilters = (next: DiscoverFilters) => {
    setFilters(next);
    keepFilters(next);
  };
  const changeExtensionFilters = (next: DiscoverFilters) => {
    setExtensionFilters(next);
    keepFilters(next, EXTENSION_FILTER_PREFIX);
  };
  const { data: health } = useQuery(
    {
      queryKey: ['source-health'],
      queryFn: ({ signal }) => getSourceHealth(signal),
      staleTime: 60_000,
      refetchOnWindowFocus: true,
    },
    queryClient,
  );
  const isFailing = (source: DisplaySource) =>
    summarizeSourceHealth(health?.find((entry) => entry.sourceId === source.id)) === 'failing';
  const { user } = useCurrentUser();
  const visible = allSources.filter(
    (source) =>
      !privacy.hideAdult ||
      !isAdultSource(installedByKey.get(source.id)?.content_rating, source.isNSFW),
  );
  const originOf = (source: DisplaySource) =>
    source.provider === 'suwayomi'
      ? SUWAYOMI_ORIGIN
      : repositoryOrigin(installedByKey.get(source.id)?.repository_id ?? '');
  const ratingOf = (source: DisplaySource) =>
    installedByKey.get(source.id)?.content_rating ?? (source.isNSFW ? 'nsfw' : 'safe');
  // A site available both ways shows as one card: the extension, with a link to the other.
  const siteKey = (source: DisplaySource) =>
    `${source.name.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '')}:${sourceLanguageGroup(source.lang)}`;
  const suwayomiBySite = new Map(
    visible.filter((source) => source.provider === 'suwayomi').map((s) => [siteKey(s), s]),
  );
  const extensionSites = new Set(
    visible.filter((source) => source.provider !== 'suwayomi').map(siteKey),
  );
  const isFoldedDuplicate = (source: DisplaySource) =>
    source.provider === 'suwayomi' &&
    extensionSites.has(siteKey(source)) &&
    filters.origin !== SUWAYOMI_ORIGIN;
  const sources = visible
    .filter(
      (source) =>
        !isFoldedDuplicate(source) &&
        source.name.toLocaleLowerCase().includes(name.trim().toLocaleLowerCase()) &&
        (!filters.language || sourceLanguageGroup(source.lang) === filters.language) &&
        (!filters.origin || originOf(source) === filters.origin) &&
        (!filters.rating || ratingOf(source) === filters.rating) &&
        (!filters.health || isFailing(source)),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  const byLanguage = compareLanguageGroups;
  // Pinned sources get their own section, in pin order, and leave their language's.
  const pinnedSources = pins.flatMap((id) => sources.filter((source) => source.id === id));
  const unpinned = sources.filter((source) => !pins.includes(source.id));
  const languageGroups = [
    ...new Set(unpinned.map((source) => sourceLanguageGroup(source.lang))),
  ].sort(byLanguage);
  const filterLanguages = [
    ...new Set(visible.map((source) => sourceLanguageGroup(source.lang))),
  ].sort(byLanguage);
  // Each extension repository by its author, then the Suwayomi server.
  const originChoices = (ids: Iterable<string>, withSuwayomi: boolean) => [
    ...repositories
      .filter((repository) => [...ids].includes(repository.id))
      .map((repository) => ({
        value: repositoryOrigin(repository.id),
        label: repositoryPublisher(repository),
      }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    ...(withSuwayomi ? [{ value: SUWAYOMI_ORIGIN, label: 'Suwayomi' }] : []),
  ];
  const installedOrigins = originChoices(
    new Set(installed.map((row) => row.repository_id)),
    visible.some((source) => source.provider === 'suwayomi'),
  );
  const filtered = Boolean(
    name.trim() || filters.language || filters.origin || filters.rating || filters.health,
  );
  const extensionOrigins = originChoices(
    repositories.map((repository) => repository.id),
    suwayomi.enabled,
  );
  const extensionLanguages = [
    ...new Set([
      ...catalogueEntries.map((item) => sourceLanguageGroup(item.entry.lang)),
      ...(suwayomi.list.data ?? []).map((extension) => sourceLanguageGroup(extension.lang)),
    ]),
  ].sort(byLanguage);
  const extensionRepository = originRepositoryId(extensionFilters.origin);
  const shownPins = pinnedSources.map((source) => source.id);
  // Moves a pin past its neighbour in the pinned section as shown.
  const reorder = (id: string, direction: number) =>
    setPins((current) => {
      const position = shownPins.indexOf(id);
      const targetId = shownPins[position + direction];
      if (position < 0 || !targetId) return current;
      const index = current.indexOf(id),
        target = current.indexOf(targetId);
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  const toggle = (list: string[], id: string) =>
    list.includes(id) ? list.filter((item) => item !== id) : [...list, id];
  const card = (source: DisplaySource) => (
    <InstalledSourceCard
      key={source.id}
      source={source}
      record={installedByKey.get(source.id)}
      alternate={source.provider === 'suwayomi' ? undefined : suwayomiBySite.get(siteKey(source))}
      listingIconUrl={
        catalogueEntries.find(
          (item) =>
            item.entry.source_key === source.id &&
            item.repositoryId === installedByKey.get(source.id)?.repository_id,
        )?.entry.icon_url
      }
      editionEntries={sourceLanguageEditions(
        source.id,
        installedByKey.get(source.id)?.repository_id,
        catalogueEntries,
      ).filter(
        (item) =>
          !privacy.hideAdult || !isAdultSource(item.entry.content_rating, item.entry.isNSFW),
      )}
      pinned={pins.includes(source.id)}
      privateReading={incognito.includes(source.id)}
      onTogglePin={() => setPins((current) => toggle(current, source.id))}
      onToggleIncognito={() => setIncognito((current) => toggle(current, source.id))}
      canMoveUp={shownPins.indexOf(source.id) > 0}
      canMoveDown={
        shownPins.indexOf(source.id) >= 0 && shownPins.indexOf(source.id) < shownPins.length - 1
      }
      onMovePin={(direction) => reorder(source.id, direction)}
      picked={picked?.includes(source.id)}
      onPick={picked ? () => setPicked((current) => toggle(current ?? [], source.id)) : undefined}
    />
  );
  const section = (key: string, label: string, list: DisplaySource[], icon?: ReactNode) => (
    <section key={key} aria-label={`${label} installed sources`}>
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
        {icon}
        {label}
        <span className="text-xs font-normal text-muted-foreground">{list.length}</span>
      </h2>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(17rem,1fr))] gap-3">
        {list.map(card)}
      </div>
    </section>
  );
  if (query)
    return (
      <div className="min-w-0 px-6 py-8">
        <h1 className="text-display text-4xl">Results for “{query}”</h1>
        <div className="mt-3 flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
          <span>Searching {visible.length} sources</span>
          <Link href="/discover" className="text-primary">
            Clear search
          </Link>
        </div>
        {visible.map((source) => (
          <SourceSearchCarousel
            key={(user?.id ?? 'anonymous') + ':' + source.id}
            source={source}
            query={query}
          />
        ))}
        {!loading && !allSources.length && <NoSourcesEmptyState />}
        {!loading && allSources.length > 0 && !visible.length && (
          <p className="mt-6 text-sm text-muted-foreground">
            No sources are visible. Adjust content visibility in Settings.
          </p>
        )}
      </div>
    );
  return (
    <div className="mx-auto min-w-0 max-w-7xl px-6 py-8 sm:px-8">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-widest text-muted-foreground">
        <Puzzle size={14} className="text-primary" />
        Discover
      </div>
      <h1 className="mt-2 text-display text-4xl">Sources</h1>
      <Tabs value={tab} onValueChange={changeTab} className="mt-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <TabsList>
            <TabsTrigger value="installed">Installed sources</TabsTrigger>
            <TabsTrigger value="extensions">Add sources</TabsTrigger>
          </TabsList>
          <div className="flex w-full min-w-0 flex-none items-center gap-2 rounded-xl border border-border bg-surface/40 px-3 py-2 sm:w-auto sm:flex-1 sm:max-w-sm">
            <Search size={18} className="shrink-0 text-muted-foreground" />
            <input
              type="search"
              aria-label="Search sources"
              placeholder="Search sources…"
              value={name}
              onChange={(event) => setName(event.target.value)}
              // The clear button below replaces the browser's own, so there is only one.
              className="min-w-0 flex-1 bg-transparent text-sm outline-none pointer-coarse:min-h-6 [&::-webkit-search-cancel-button]:appearance-none"
            />
            {name && (
              <button
                type="button"
                aria-label="Clear source search"
                onClick={() => setName('')}
                className="inline-flex shrink-0 items-center justify-center pointer-coarse:min-h-6 pointer-coarse:min-w-6"
              >
                <X size={16} />
              </button>
            )}
          </div>
        </div>
        <TabsContent value="installed" className="mt-6">
          <DiscoverFilterBar
            label="Installed source filters"
            value={filters}
            onChange={changeFilters}
            languages={filterLanguages}
            origins={installedOrigins}
            showHealth
            count={sources.length}
            filtered={filtered}
          />
          {loading && !sources.length ? (
            <SourceCardsSkeleton />
          ) : !sources.length ? (
            <div className="rounded-2xl border border-dashed border-border p-10 text-center">
              <p className="text-sm text-muted-foreground">
                {allSources.length
                  ? 'No sources match your search, filters or content preferences.'
                  : 'Install a source to start reading.'}
              </p>
              <button
                type="button"
                className="mt-4 text-sm text-primary pointer-coarse:min-h-11"
                onClick={() => {
                  if (allSources.length) {
                    setName('');
                    changeFilters(EMPTY_DISCOVER_FILTERS);
                  } else changeTab('extensions');
                }}
              >
                {allSources.length ? 'Clear search and filters' : 'Browse sources'}
              </button>
            </div>
          ) : (
            <div className="space-y-8">
              <button
                type="button"
                aria-pressed={picked !== null}
                className="text-sm text-primary pointer-coarse:min-h-11"
                onClick={() => setPicked((current) => (current ? null : []))}
              >
                {picked ? 'Cancel selection' : 'Select sources'}
              </button>
              {pinnedSources.length > 0 &&
                section(
                  'pinned',
                  'Pinned',
                  pinnedSources,
                  <Pin size={14} aria-hidden="true" className="text-primary" />,
                )}
              {languageGroups.map((language) =>
                section(
                  language,
                  sourceLanguageName(language),
                  unpinned.filter((source) => sourceLanguageGroup(source.lang) === language),
                ),
              )}
            </div>
          )}
          {picked && (
            <SourceBulkBar
              ids={picked}
              records={picked.flatMap((id) => installedByKey.get(id) ?? [])}
              onPin={() => {
                setPins((current) => [...new Set([...current, ...picked])]);
                setPicked([]);
              }}
              onClose={() => setPicked(null)}
            />
          )}
        </TabsContent>
        <TabsContent value="extensions" className="mt-6">
          <DiscoverFilterBar
            label="Extension filters"
            value={extensionFilters}
            onChange={changeExtensionFilters}
            languages={extensionLanguages}
            origins={extensionOrigins}
            filtered={false}
          />
          {extensionFilters.origin !== SUWAYOMI_ORIGIN && (
            <SourceCatalog
              filters={{ ...emptySourceFilters, name, rating: extensionFilters.rating }}
              language={extensionFilters.language}
              repositoryId={extensionRepository}
            />
          )}
          {!extensionRepository && <SuwayomiExtensions name={name} filters={extensionFilters} />}
        </TabsContent>
      </Tabs>
    </div>
  );
}
