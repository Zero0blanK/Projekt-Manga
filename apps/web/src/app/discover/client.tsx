'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
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
import { InstalledSourceCard } from '@/components/discover/installed-source-card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Puzzle, Search, X } from 'lucide-react';

export function DiscoverPageClient() {
  const params = useSearchParams(),
    query = params.get('q')?.trim() ?? '';
  const { sources: apiSources, loading } = useSources();
  const { installed } = useInstalledExtensions();
  const { entries: catalogueEntries = [] } = useSourceCatalog();
  const allSources = apiSources.map(toDisplaySource);
  const installedByKey = new Map(installed.map((row) => [row.source_key, row]));
  const [privacy] = useContentPrivacy();
  const [pins, setPins] = useProfilePreference('pinnedSources', parseIdList, EMPTY_IDS);
  const [incognito, setIncognito] = useProfilePreference(
    'incognitoSources',
    parseIdList,
    EMPTY_IDS,
  );
  const [name, setName] = useState('');
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
  const { user } = useCurrentUser();
  const visible = allSources.filter(
    (source) =>
      !privacy.hideAdult ||
      !isAdultSource(installedByKey.get(source.id)?.content_rating, source.isNSFW),
  );
  const sources = visible
    .filter((source) => source.name.toLocaleLowerCase().includes(name.trim().toLocaleLowerCase()))
    .sort((a, b) => {
      const left = pins.indexOf(a.id),
        right = pins.indexOf(b.id);
      return (
        (left < 0 ? Number.MAX_SAFE_INTEGER : left) -
          (right < 0 ? Number.MAX_SAFE_INTEGER : right) || a.name.localeCompare(b.name)
      );
    });
  const languageGroups = [
    ...new Set(sources.map((source) => sourceLanguageGroup(source.lang))),
  ].sort((a, b) => sourceLanguageName(a).localeCompare(sourceLanguageName(b)));
  const reorder = (id: string, direction: number) =>
    setPins((current) => {
      const source = allSources.find((item) => item.id === id);
      if (!source) return current;
      const groupPins = current.filter((key) =>
        allSources.some(
          (item) =>
            item.id === key && sourceLanguageGroup(item.lang) === sourceLanguageGroup(source.lang),
        ),
      );
      const position = groupPins.indexOf(id);
      const targetId = groupPins[position + direction];
      if (position < 0 || !targetId) return current;
      const index = current.indexOf(id),
        target = current.indexOf(targetId);
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
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
            <TabsTrigger value="extensions">Extensions</TabsTrigger>
          </TabsList>
          <div className="flex w-full min-w-0 flex-none items-center gap-2 rounded-xl border border-border bg-surface/40 px-3 py-2 sm:w-auto sm:flex-1 sm:max-w-sm">
            <Search size={18} className="shrink-0 text-muted-foreground" />
            <input
              type="search"
              aria-label="Search sources"
              placeholder="Search sources…"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="min-w-0 flex-1 bg-transparent text-sm outline-none pointer-coarse:min-h-6"
            />
            {name && (
              <button
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
          {loading && !sources.length ? (
            <SourceCardsSkeleton />
          ) : !sources.length ? (
            <div className="rounded-2xl border border-dashed border-border p-10 text-center">
              <p className="text-sm text-muted-foreground">
                {allSources.length
                  ? 'No sources match your search or content preferences.'
                  : 'Install an extension to start reading.'}
              </p>
              <button
                className="mt-4 text-sm text-primary"
                onClick={() => {
                  if (allSources.length) {
                    setName('');
                  } else changeTab('extensions');
                }}
              >
                {allSources.length ? 'Clear source search' : 'Browse extensions'}
              </button>
            </div>
          ) : (
            <div className="space-y-8">
              {languageGroups.map((language) => {
                const languageSources = sources.filter(
                  (source) => sourceLanguageGroup(source.lang) === language,
                );
                const languagePins = pins.filter((key) =>
                  allSources.some(
                    (source) => source.id === key && sourceLanguageGroup(source.lang) === language,
                  ),
                );
                return (
                  <section
                    key={language}
                    aria-label={`${sourceLanguageName(language)} installed sources`}
                  >
                    <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
                      {sourceLanguageName(language)}
                      <span className="text-xs font-normal text-muted-foreground">
                        {languageSources.length}
                      </span>
                    </h2>
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                      {languageSources.map((source) => (
                        <InstalledSourceCard
                          key={source.id}
                          source={source}
                          record={installedByKey.get(source.id)}
                          editionEntries={sourceLanguageEditions(
                            source.id,
                            installedByKey.get(source.id)?.repository_id,
                            catalogueEntries,
                          ).filter(
                            (item) =>
                              !privacy.hideAdult ||
                              !isAdultSource(item.entry.content_rating, item.entry.isNSFW),
                          )}
                          pinned={pins.includes(source.id)}
                          privateReading={incognito.includes(source.id)}
                          onTogglePin={() =>
                            setPins((current) =>
                              current.includes(source.id)
                                ? current.filter((id) => id !== source.id)
                                : [...current, source.id],
                            )
                          }
                          onToggleIncognito={() =>
                            setIncognito((current) =>
                              current.includes(source.id)
                                ? current.filter((id) => id !== source.id)
                                : [...current, source.id],
                            )
                          }
                          canMoveUp={languagePins.indexOf(source.id) > 0}
                          canMoveDown={
                            languagePins.indexOf(source.id) >= 0 &&
                            languagePins.indexOf(source.id) < languagePins.length - 1
                          }
                          onMovePin={(direction) => reorder(source.id, direction)}
                        />
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>
          )}
        </TabsContent>
        <TabsContent value="extensions">
          <SourceCatalog filters={{ ...emptySourceFilters, name }} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
