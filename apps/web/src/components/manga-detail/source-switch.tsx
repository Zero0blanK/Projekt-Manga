'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Check, ArrowRightLeft } from 'lucide-react';
import { useRouter } from 'next/navigation';
import {
  getMangaDetailsById,
  getSourceMangaDetails,
  searchSourceMangaPage,
  markChapterAsRead,
  setMangaInLibrary,
  getAllDownloads,
  cancelDownload,
  type PublicUser,
} from '@projekt-manga/api-client';
import type { MangaDetails, Mangas } from '@projekt-manga/types';
import type { Manga } from '@/lib/manga-data';
import { useLibraryState, useMangaLibrary, useSources, libraryActions } from '@/lib/library-store';
import { addSourceMangaToLibrary } from '@/lib/discover-actions';
import { actions, getAppState } from '@/lib/app-store';
import { useCurrentUser } from '@/lib/session-resource';
import { queryClient, queryKeys } from '@/lib/query-client';
import { useInstalledExtensions } from '@/lib/extensions-store';
import { isAdultSource, useContentPrivacy } from '@/components/discover/content-privacy';
import { scheduleSourceSearch } from '@/lib/source-search-queue';
import {
  useMigrationPreferences,
  saveMigrationSearch,
  takeMigrationSearch,
  migrationReadTargets,
} from '@/lib/migration-state';
import { refreshDownloads } from '@/components/downloads/row-data';
import { setPreviousLocation } from '@/lib/nav-history';
import {
  MigrationTitleSummary,
  MigrationOptionsStage,
  MigrationMatchesStage,
  MigrationReviewStage,
  type MigrationSearchStatus,
  type MigrationPreviewStatus,
  type MigrationTransferStatus,
} from './migration-stages';

type Stage = 'options' | 'matches' | 'review';
const emptySearch: MigrationSearchStatus = {
  state: 'idle',
  sourceIds: [],
  settled: [],
  failed: [],
};
const newCheckpoint = () => ({
  membership: false,
  shelf: false,
  bookmark: false,
  categories: false,
  downloads: false,
  removed: false,
  read: new Set<string>(),
});

export function SourceSwitch({ manga }: { manga: Manga }) {
  // Styled like the action bar's other icon buttons rather than with the generic shadcn
  // Button: `size="icon"` is a 36px rounded-md square, which would clash with the 40px
  // circles around it.
  return (
    <Link
      href={`/manga/${encodeURIComponent(manga.id)}/migrate`}
      aria-label="Migrate manga"
      title="Migrate manga"
      className="grid h-10 w-10 place-items-center rounded-full border border-border/60 bg-surface/60 text-foreground transition hover:bg-surface"
    >
      <ArrowRightLeft className="h-4 w-4" />
    </Link>
  );
}

export function SourceMigration({ manga }: { manga: Manga }) {
  const { sources, loading: sourcesLoading } = useSources();
  const router = useRouter();
  const { installed } = useInstalledExtensions();
  const [privacy] = useContentPrivacy();
  const candidates = sources.filter(
    (entry) =>
      entry.id !== manga.source &&
      (!privacy.hideAdult ||
        !isAdultSource(
          installed.find((extension) => extension.source_key === entry.id)?.content_rating,
          entry.isNSFW,
        )),
  );
  const { manga: library, refresh } = useMangaLibrary();
  const { shelf, bookmarks } = useLibraryState();
  const { user, loading: sessionLoading } = useCurrentUser();
  const owner = user?.id ?? 'anonymous';
  const [stage, setStage] = useState<Stage>('options');
  const [query, setQuery] = useState(manga.title);
  const [preferences, setPreferences] = useMigrationPreferences();
  const { sourceOrder, hideUnmatched, options } = preferences;
  const [appliedHideUnmatched, setAppliedHideUnmatched] = useState(false);
  const [appliedOptions, setAppliedOptions] = useState(options);
  const appliedQuery = useRef('');
  const [results, setResults] = useState<Mangas[]>([]);
  const [searchStatus, setSearchStatus] = useState<MigrationSearchStatus>(emptySearch);
  const [selected, setSelected] = useState<Mangas | null>(null);
  const [details, setDetails] = useState<MangaDetails | null>(null);
  const [originalCount, setOriginalCount] = useState<number | null>(null);
  const [readTargets, setReadTargets] = useState<Set<string>>(new Set());
  const [originalReadCount, setOriginalReadCount] = useState(0);
  const [railScrolls, setRailScrolls] = useState<Record<string, number>>({});
  const [previewStatus, setPreviewStatus] = useState<MigrationPreviewStatus>('idle');
  const [transfer, setTransfer] = useState<MigrationTransferStatus>({ state: 'idle' });
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const targetId = useRef<string | null>(null);
  const checkpoint = useRef(newCheckpoint());
  const saving = useRef(false);
  const matchesScroll = useRef(0);
  const stageRoot = useRef<HTMLDivElement>(null);
  const sourceAllowed = !!selected && candidates.some((entry) => entry.id === selected.source);
  const complete = transfer.state === 'success';
  const isCurrent = () =>
    (queryClient.getQueryData<PublicUser | null>(queryKeys.session)?.id ?? 'anonymous') === owner;

  const clearComparison = () => {
    setSelected(null);
    setDetails(null);
    setOriginalCount(null);
    setReadTargets(new Set());
    setOriginalReadCount(0);
    setPreviewStatus('idle');
    setTransfer({ state: 'idle' });
    targetId.current = null;
    checkpoint.current = newCheckpoint();
  };
  useEffect(
    () => () => {
      generation.current++;
      request.current?.abort();
    },
    [],
  );
  useEffect(() => {
    if (sessionLoading || sourcesLoading) return;
    generation.current++;
    request.current?.abort();
    saving.current = false;
    clearComparison();
    setResults([]);
    setSearchStatus(emptySearch);
    setStage('options');
    setQuery(manga.title);
    setRailScrolls({});
    const restored = takeMigrationSearch(owner, manga.id, privacy.hideAdult);
    if (restored) {
      setQuery(restored.query);
      appliedQuery.current = restored.appliedQuery;
      setResults(restored.results);
      setAppliedOptions(restored.options);
      setAppliedHideUnmatched(restored.hideUnmatched);
      setSearchStatus({
        ...restored.status,
        state: restored.status.state === 'searching' ? 'paused' : restored.status.state,
      });
      matchesScroll.current = restored.scrollY;
      setRailScrolls(restored.rails);
      setStage('matches');
    }
  }, [owner, manga.id, manga.title, privacy.hideAdult, sessionLoading, sourcesLoading]);
  useEffect(() => {
    if (!selected || sourceAllowed) return;
    generation.current++;
    request.current?.abort();
    saving.current = false;
    clearComparison();
    setStage('options');
    setSearchStatus(emptySearch);
    setResults([]);
  }, [selected, sourceAllowed]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const heading = stageRoot.current?.querySelector<HTMLElement>(
        '[data-migration-stage-heading], [data-migration-outcome]',
      );
      if (heading) {
        heading.tabIndex = -1;
        heading.focus({ preventScroll: true });
      }
      if (stage === 'matches') window.scrollTo({ top: matchesScroll.current });
      else window.scrollTo({ top: 0 });
    });
    return () => cancelAnimationFrame(frame);
  }, [stage, complete]);

  const runSearch = async (
    ids: string[],
    searchQuery: string,
    allIds: string[],
    fresh: boolean,
  ) => {
    if (!ids.length || sessionLoading || !isCurrent() || saving.current) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const version = generation.current;
    const current = () =>
      !controller.signal.aborted && generation.current === version && isCurrent();
    setSearchStatus((previous) => ({
      state: 'searching',
      sourceIds: allIds,
      settled: fresh
        ? []
        : previous.settled.filter((id) => allIds.includes(id) && !ids.includes(id)),
      failed: fresh ? [] : previous.failed.filter((id) => allIds.includes(id) && !ids.includes(id)),
    }));
    await Promise.all(
      ids.map(async (id) => {
        let failed = false;
        try {
          const page = await scheduleSourceSearch(controller.signal, () =>
            searchSourceMangaPage(id, { query: searchQuery, limit: 20 }, controller.signal),
          );
          if (current())
            setResults((previous) => {
              const seen = new Set(previous.map((item) => `${item.source}:${item.id}`));
              const added = page.items
                .filter((item) => {
                  const key = `${id}:${item.id}`;
                  if (seen.has(key)) return false;
                  seen.add(key);
                  return true;
                })
                .map((item) => ({ ...item, source: id }));
              return [...previous, ...added];
            });
        } catch {
          failed = true;
        }
        if (current())
          setSearchStatus((previous) => ({
            ...previous,
            settled: [...previous.settled, id],
            failed: failed ? [...previous.failed, id] : previous.failed,
          }));
      }),
    );
    if (current()) setSearchStatus((previous) => ({ ...previous, state: 'complete' }));
  };
  const apply = () => {
    const ids = sourceOrder.filter((id) => candidates.some((entry) => entry.id === id));
    if (!query.trim() || !ids.length || sessionLoading || !isCurrent()) return;
    clearComparison();
    setResults([]);
    setAppliedOptions({ ...options });
    setAppliedHideUnmatched(hideUnmatched);
    appliedQuery.current = query.trim();
    matchesScroll.current = 0;
    setRailScrolls({});
    setStage('matches');
    void runSearch(ids, appliedQuery.current, ids, true);
  };
  const edit = () => {
    if (saving.current) return;
    request.current?.abort();
    clearComparison();
    setStage('options');
    setSearchStatus(emptySearch);
  };
  const searchTitles = () => {
    const ids = searchStatus.sourceIds.filter((id) => candidates.some((entry) => entry.id === id));
    if (!query.trim() || !ids.length || sessionLoading || !isCurrent()) return;
    clearComparison();
    setResults([]);
    setRailScrolls({});
    appliedQuery.current = query.trim();
    void runSearch(ids, appliedQuery.current, ids, true);
  };
  const returnToMatches = () => {
    if (saving.current) return;
    request.current?.abort();
    clearComparison();
    setStage('matches');
  };
  const captureSearchPosition = () => {
    matchesScroll.current = window.scrollY;
    const rails: Record<string, number> = {};
    stageRoot.current
      ?.querySelectorAll<HTMLElement>('[data-migration-result-source]')
      .forEach((element) => {
        rails[element.dataset.migrationResultSource!] = element.scrollLeft;
      });
    setRailScrolls(rails);
    return rails;
  };
  const inspect = (item: Mangas) => {
    if (sessionLoading || !isCurrent() || !candidates.some((source) => source.id === item.source))
      return;
    const rails = captureSearchPosition();
    saveMigrationSearch(owner, manga.id, {
      query,
      appliedQuery: appliedQuery.current,
      results,
      status: searchStatus,
      options: appliedOptions,
      hideUnmatched: appliedHideUnmatched,
      hideAdult: privacy.hideAdult,
      scrollY: matchesScroll.current,
      rails,
    });
    setPreviousLocation(`/manga/${encodeURIComponent(manga.id)}/migrate`);
    router.push(
      `/discover/preview/${encodeURIComponent(item.source)}/${encodeURIComponent(item.id)}`,
    );
  };
  const searchAgain = (resume: boolean) => {
    const allowed = new Set(candidates.map((entry) => entry.id));
    const allIds = searchStatus.sourceIds.filter((id) => allowed.has(id));
    const failedIds = searchStatus.failed.filter((id) => allowed.has(id));
    const ids = (
      resume
        ? allIds.filter((id) => !searchStatus.settled.includes(id))
        : failedIds.length
          ? failedIds
          : allIds
    ).filter((id) => allowed.has(id));
    void runSearch(ids, appliedQuery.current, allIds, false);
  };
  const preview = async (item: Mangas, retry = false) => {
    if (
      saving.current ||
      sessionLoading ||
      !isCurrent() ||
      !candidates.some((entry) => entry.id === item.source)
    )
      return;
    if (!retry) captureSearchPosition();
    request.current?.abort();
    setSearchStatus((previous) => ({
      ...previous,
      state: previous.settled.length < previous.sourceIds.length ? 'paused' : 'complete',
    }));
    const controller = new AbortController();
    request.current = controller;
    const version = generation.current;
    const current = () =>
      !controller.signal.aborted && generation.current === version && isCurrent();
    clearComparison();
    setSelected(item);
    setStage('review');
    setPreviewStatus('loading');
    try {
      const [replacement, original] = await Promise.all([
        getSourceMangaDetails(item.source, item.id, controller.signal),
        getMangaDetailsById(manga.id, controller.signal),
      ]);
      if (!current()) return;
      setDetails(replacement);
      setOriginalCount(original.chapters.length);
      setOriginalReadCount(original.chapters.filter((chapter) => chapter.is_read).length);
      setReadTargets(
        appliedOptions.read
          ? migrationReadTargets(original.chapters, replacement.chapters)
          : new Set(),
      );
      setPreviewStatus('ready');
    } catch {
      if (current()) setPreviewStatus('error');
    }
  };
  const migrate = async () => {
    if (
      !details ||
      !selected ||
      previewStatus !== 'ready' ||
      saving.current ||
      !sourceAllowed ||
      sessionLoading ||
      !isCurrent()
    )
      return;
    const version = generation.current;
    const current = () => generation.current === version && isCurrent();
    saving.current = true;
    setTransfer({ state: 'saving', label: 'Preparing replacement…' });
    const done = checkpoint.current;
    try {
      const existing = library.find(
        (entry) =>
          entry.source === selected.source &&
          (entry.slug === details.slug || entry.slug === details.id),
      );
      const id =
        targetId.current ??
        existing?.id ??
        (await addSourceMangaToLibrary(selected.source, details, details, false));
      if (!current()) return;
      targetId.current = id;
      if (!done.membership) {
        await setMangaInLibrary(id, true);
        if (!current()) return;
        done.membership = true;
      }
      setTransfer({ state: 'saving', label: 'Transferring library settings…' });
      if (!done.shelf && appliedOptions.shelf && shelf[manga.id]) {
        await libraryActions.setShelf(id, shelf[manga.id]);
        if (!current()) return;
        done.shelf = true;
      }
      if (!done.bookmark && appliedOptions.bookmark && bookmarks.includes(manga.id)) {
        await libraryActions.setBookmark(id, true);
        if (!current()) return;
        done.bookmark = true;
      }
      const failures: string[] = [];
      const pending = details.chapters.filter(
        (chapter) => readTargets.has(chapter.id) && !done.read.has(chapter.id),
      );
      for (const [index, replacement] of pending.entries()) {
        if (!current()) return;
        setTransfer({
          state: 'saving',
          label: `Transferring progress ${index + 1} of ${pending.length}…`,
        });
        try {
          await markChapterAsRead(details.slug || details.id, replacement.id, {
            ...replacement,
            source: selected.source,
          });
          if (!current()) return;
          done.read.add(replacement.id);
        } catch {
          if (!current()) return;
          failures.push(replacement.id);
        }
      }
      if (!current()) return;
      if (!done.categories && appliedOptions.categories) {
        for (const [category, members] of Object.entries(getAppState().categoryMembers))
          if (members.includes(manga.id) && !members.includes(id))
            actions.toggleCategoryMember(category, id);
        done.categories = true;
      }
      if (failures.length) {
        setTransfer({
          state: 'partial',
          failed: failures,
          message: `${failures.length} chapter transfers failed. The original remains in your library. Retry to finish.`,
        });
        void refresh();
        return;
      }
      if (!done.downloads) {
        setTransfer({ state: 'saving', label: 'Removing original downloads…' });
        const downloads = await getAllDownloads();
        if (!current()) return;
        for (const download of downloads.filter((entry) => entry.manga_id === manga.id)) {
          if (!current()) return;
          await cancelDownload(download.id);
          if (!current()) return;
        }
        done.downloads = true;
        refreshDownloads();
      }
      if (!current()) return;
      if (!done.removed) {
        setTransfer({ state: 'saving', label: 'Removing original from library…' });
        await setMangaInLibrary(manga.id, false);
        if (!current()) return;
        done.removed = true;
      }
      void refresh();
      setTransfer({ state: 'success', targetId: id });
    } catch {
      if (current())
        setTransfer({
          state: 'partial',
          failed: [],
          message:
            'Migration or cleanup was interrupted. Completed work is saved. Retry to finish before the original is removed from your library.',
        });
    } finally {
      if (current()) saving.current = false;
    }
  };
  const steps: Stage[] = ['options', 'matches', 'review'];
  const active = steps.indexOf(stage);
  const locked = transfer.state === 'saving' || transfer.state === 'success';
  const stepLabels: Record<Stage, string> = {
    options: 'Choose sources',
    matches: 'Find a match',
    review: 'Review',
  };
  return (
    <div ref={stageRoot}>
      {stage !== 'review' && (
        <MigrationTitleSummary
          manga={manga}
          sourceName={sources.find((entry) => entry.id === manga.source)?.name ?? manga.source}
        />
      )}
      <nav aria-label="Migration steps" className="mb-8">
        <ol className="flex items-center">
          {steps.map((step, index) => {
            const done = index < active;
            const current = index === active;
            return (
              <li key={step} className={`flex items-center ${index ? 'flex-1' : ''}`}>
                {index > 0 && (
                  <span
                    aria-hidden="true"
                    className={`mx-2 h-px flex-1 sm:mx-3 ${done || current ? 'bg-primary/60' : 'bg-border'}`}
                  />
                )}
                <button
                  type="button"
                  aria-current={current ? 'step' : undefined}
                  aria-label={`Step ${index + 1} of ${steps.length}: ${stepLabels[step]}${done ? ', completed' : ''}`}
                  disabled={locked || index >= active}
                  onClick={step === 'options' ? edit : returnToMatches}
                  className={`flex shrink-0 items-center gap-2 rounded-full py-1 pl-1 pr-3 text-sm transition focus-visible:outline-2 focus-visible:outline-primary ${current ? 'text-foreground' : done ? 'text-foreground/80 enabled:hover:text-primary' : 'text-muted-foreground'}`}
                >
                  <span
                    className={`flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${current ? 'bg-primary text-primary-foreground shadow-sm shadow-primary/30' : done ? 'bg-primary/15 text-primary' : 'border border-border text-muted-foreground'}`}
                  >
                    {done ? <Check size={14} /> : index + 1}
                  </span>
                  <span className={`font-medium ${current ? '' : 'hidden sm:inline'}`}>
                    {stepLabels[step]}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </nav>
      {stage === 'options' && (
        <MigrationOptionsStage
          sources={candidates}
          selectedIds={sourceOrder}
          options={options}
          hideUnmatched={hideUnmatched}
          disabled={sessionLoading || sourcesLoading}
          onSources={(sourceOrder) => setPreferences((current) => ({ ...current, sourceOrder }))}
          onHideUnmatched={(hideUnmatched) =>
            setPreferences((current) => ({ ...current, hideUnmatched }))
          }
          onOptions={(options) => setPreferences((current) => ({ ...current, options }))}
          onApply={apply}
        />
      )}
      {stage === 'matches' && (
        <MigrationMatchesStage
          results={results}
          sources={searchStatus.sourceIds.flatMap((id) => {
            const source = candidates.find((entry) => entry.id === id);
            return source ? [source] : [];
          })}
          query={query}
          hideUnmatched={appliedHideUnmatched}
          disabled={sessionLoading}
          onQuery={setQuery}
          onSearch={searchTitles}
          onInspect={inspect}
          railScrolls={railScrolls}
          status={{
            ...searchStatus,
            sourceIds: searchStatus.sourceIds.filter((id) =>
              candidates.some((entry) => entry.id === id),
            ),
            settled: searchStatus.settled.filter((id) =>
              candidates.some((entry) => entry.id === id),
            ),
            failed: searchStatus.failed.filter((id) => candidates.some((entry) => entry.id === id)),
          }}
          onChoose={(item) => void preview(item)}
          onEdit={edit}
          onRetry={() => searchAgain(false)}
          onResume={() => searchAgain(true)}
        />
      )}
      {stage === 'review' && selected && (
        <MigrationReviewStage
          manga={manga}
          originalSource={sources.find((entry) => entry.id === manga.source)?.name ?? manga.source}
          replacementSource={
            sources.find((entry) => entry.id === selected.source)?.name ?? selected.source
          }
          selected={selected}
          details={details}
          originalCount={originalCount}
          preview={previewStatus}
          matchedCount={readTargets.size}
          originalReadCount={originalReadCount}
          options={appliedOptions}
          transfer={transfer}
          error="Could not load the comparison. Please try again."
          onBack={returnToMatches}
          onEdit={edit}
          onRetryPreview={() => void preview(selected, true)}
          onMigrate={() => void migrate()}
        />
      )}
    </div>
  );
}
