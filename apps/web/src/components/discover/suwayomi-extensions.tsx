'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw, Server } from 'lucide-react';
import {
  ApiError,
  changeSuwayomiExtension,
  getSuwayomiExtensions,
  getSuwayomiSettings,
  type SuwayomiExtension,
} from '@projekt-manga/api-client';
import { queryClient as client, queryKeys } from '@/lib/query-client';
import { sourceLanguageGroup, sourceLanguageName } from '@/lib/source-language';
import { compareLanguageGroups, type DiscoverFilters } from '@/lib/discover-filters';
import { isProxyPlaceholder, sourceIconUrl } from '@/lib/source-url';
import { toast } from '@/hooks/use-toast';
import { useContentPrivacy } from './content-privacy';

const EXTENSIONS_KEY = ['suwayomi', 'extensions'] as const;

function ExtensionIcon({ url }: { url: string | null }) {
  const [failed, setFailed] = useState(false);
  const src = sourceIconUrl(url);
  if (!src || failed) return <span aria-hidden className="size-5 shrink-0 rounded bg-secondary" />;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- the server's own image proxy
    <img
      src={src}
      alt=""
      aria-hidden
      width={20}
      height={20}
      loading="lazy"
      onError={() => setFailed(true)}
      onLoad={(event) => setFailed(isProxyPlaceholder(event.currentTarget))}
      className="size-5 shrink-0 rounded object-contain"
    />
  );
}

/** Rows added at a time: a server can list well over a thousand extensions. */
const ROW_STEP = 60;

/** Renders the first rows of a long list and adds more as the end nears the screen. */
function GrowingList<T>({
  rows,
  render,
  className,
}: {
  rows: T[];
  render: (row: T) => ReactNode;
  className?: string;
}) {
  const [shown, setShown] = useState(ROW_STEP);
  const end = useRef<HTMLLIElement>(null);
  const more = shown < rows.length;
  useEffect(() => {
    const element = end.current;
    if (!more || !element) return;
    if (typeof IntersectionObserver === 'undefined') {
      setShown(rows.length);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setShown((current) => current + ROW_STEP);
        }
      },
      { rootMargin: '600px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [more, rows.length, shown]);
  return (
    <ul className={className}>
      {rows.slice(0, shown).map(render)}
      {more && (
        <li ref={end} className="px-5 py-3 text-xs text-muted-foreground">
          {rows.length - shown} more…
        </li>
      )}
    </ul>
  );
}

const errorText = (error: unknown, fallback: string) =>
  error instanceof ApiError && error.message ? error.message : fallback;

/**
 * Discover › Extensions › Suwayomi: every Mihon extension the connected Suwayomi server can
 * install, not only the installed ones. Installing, updating and removing happen on that
 * server; the sources an extension adds then show under Installed sources.
 *
 * Shown only when a Suwayomi server is connected and this reader may manage it (the
 * endpoints are admin-only, like extension repositories).
 */
/**
 * The connected Suwayomi server's extensions: whether there is one this reader may manage
 * (the endpoints are admin-only, like extension repositories), and its list once loaded.
 */
export function useSuwayomiExtensions() {
  const settings = useQuery(
    {
      queryKey: ['suwayomi', 'settings'],
      queryFn: ({ signal }) => getSuwayomiSettings(signal),
      retry: false,
    },
    client,
  );
  const enabled = settings.data?.enabled === true;
  const list = useQuery(
    {
      queryKey: EXTENSIONS_KEY,
      queryFn: ({ signal }) => getSuwayomiExtensions(false, signal),
      enabled,
      retry: false,
    },
    client,
  );
  return { enabled, list };
}

/**
 * Discover › Extensions › Suwayomi: every Mihon extension the connected Suwayomi server can
 * install, not only the installed ones. Installing, updating and removing happen on that
 * server; the sources an extension adds then show under Installed sources. Follows the
 * page's name search and its language and rating filters.
 */
export function SuwayomiExtensions({
  name,
  filters,
}: {
  name: string;
  filters: Pick<DiscoverFilters, 'language' | 'rating'>;
}) {
  const [privacy] = useContentPrivacy();
  const [refreshing, setRefreshing] = useState(false);
  // Per row, so one install doesn't freeze every other row.
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const { enabled, list } = useSuwayomiExtensions();
  if (!enabled) return null;

  const refresh = async () => {
    setRefreshing(true);
    try {
      client.setQueryData(EXTENSIONS_KEY, await getSuwayomiExtensions(true));
      toast({ description: 'Suwayomi extension list refreshed.' });
    } catch (error) {
      toast({ description: errorText(error, "Couldn't refresh Suwayomi's extensions.") });
    } finally {
      setRefreshing(false);
    }
  };
  const change = async (
    extension: SuwayomiExtension,
    action: 'install' | 'update' | 'uninstall',
  ) => {
    setBusy((current) => new Set(current).add(extension.pkg_name));
    try {
      const next = await changeSuwayomiExtension(extension.pkg_name, action);
      client.setQueryData<SuwayomiExtension[]>(EXTENSIONS_KEY, (current) =>
        current?.map((item) =>
          item.pkg_name === extension.pkg_name
            ? (next ?? { ...item, installed: action !== 'uninstall', has_update: false })
            : item,
        ),
      );
      // The sources it adds or removes appear under Installed sources.
      await client.invalidateQueries({ queryKey: queryKeys.sources });
      toast({
        description: `${extension.name} ${action === 'install' ? 'installed' : action === 'update' ? 'updated' : 'removed'} on Suwayomi.`,
      });
    } catch (error) {
      toast({ description: errorText(error, `Couldn't change ${extension.name} on Suwayomi.`) });
    } finally {
      setBusy((current) => {
        const next = new Set(current);
        next.delete(extension.pkg_name);
        return next;
      });
    }
  };

  const needle = name.trim().toLocaleLowerCase();
  const visible = (list.data ?? [])
    .filter(
      (extension) =>
        (!privacy.hideAdult || !extension.is_nsfw) &&
        extension.name.toLocaleLowerCase().includes(needle) &&
        (!filters.language || sourceLanguageGroup(extension.lang) === filters.language) &&
        // Suwayomi only says whether an extension is adult; it has no "mixed".
        (!filters.rating ||
          (filters.rating === 'nsfw'
            ? extension.is_nsfw
            : filters.rating === 'safe' && !extension.is_nsfw)),
    )
    .sort(
      (a, b) =>
        compareLanguageGroups(sourceLanguageGroup(a.lang), sourceLanguageGroup(b.lang)) ||
        a.name.localeCompare(b.name),
    );
  const groups = [
    { label: 'Updates', rows: visible.filter((item) => item.installed && item.has_update) },
    { label: 'Installed', rows: visible.filter((item) => item.installed && !item.has_update) },
    { label: 'Available', rows: visible.filter((item) => !item.installed) },
  ];

  return (
    <section aria-label="Suwayomi extensions" className="mt-12">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Server aria-hidden="true" className="size-4 text-primary" />
          Suwayomi
          {list.data && (
            <span className="text-xs font-normal text-muted-foreground">{list.data.length}</span>
          )}
        </h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 px-2.5 py-1 text-xs font-medium text-foreground transition hover:bg-accent disabled:opacity-50"
          >
            <RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Mihon extensions from your Suwayomi server&apos;s repositories. They install on that server,
        and their sources appear under Installed sources.
      </p>
      {list.isPending ? (
        <p className="mt-4 text-sm text-muted-foreground">Loading Suwayomi extensions…</p>
      ) : list.isError ? (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {errorText(list.error, "Couldn't reach the Suwayomi server.")}
        </p>
      ) : visible.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">
          {list.data?.length
            ? 'No Suwayomi extensions match.'
            : 'Suwayomi lists no extensions. Add an extension repository in Suwayomi, then refresh.'}
        </p>
      ) : (
        <div className="mt-4 space-y-6">
          {groups.map(({ label, rows }) =>
            rows.length === 0 ? null : (
              <section key={label} aria-label={`Suwayomi ${label.toLowerCase()}`}>
                <h3 className="mb-2 text-sm font-semibold text-foreground">
                  {label}{' '}
                  <span className="text-xs font-normal text-muted-foreground">{rows.length}</span>
                </h3>
                <GrowingList
                  rows={rows}
                  className="divide-y divide-border/60 overflow-hidden rounded-2xl border border-border/60 bg-surface/40"
                  render={(extension) => (
                    <li
                      key={extension.pkg_name}
                      className="flex items-center justify-between gap-4 px-5 py-3"
                    >
                      <div className="flex min-w-0 items-center gap-2.5">
                        <ExtensionIcon url={extension.icon_url} />
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-foreground">
                            {extension.name}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            v{extension.version} · {sourceLanguageName(extension.lang)}
                            {extension.is_nsfw ? ' · NSFW' : ''}
                            {extension.obsolete ? ' · Obsolete' : ''}
                          </p>
                        </div>
                      </div>
                      <div className="flex shrink-0 gap-2">
                        {extension.installed && extension.has_update && (
                          <button
                            type="button"
                            disabled={busy.has(extension.pkg_name)}
                            onClick={() => void change(extension, 'update')}
                            className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
                          >
                            Update
                          </button>
                        )}
                        {extension.installed ? (
                          <button
                            type="button"
                            disabled={busy.has(extension.pkg_name)}
                            onClick={() => void change(extension, 'uninstall')}
                            className="rounded-lg border border-border/60 px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent disabled:opacity-50"
                          >
                            {busy.has(extension.pkg_name) ? 'Working…' : 'Uninstall'}
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={busy.has(extension.pkg_name) || extension.obsolete}
                            onClick={() => void change(extension, 'install')}
                            className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
                          >
                            {busy.has(extension.pkg_name) ? 'Installing…' : 'Install'}
                          </button>
                        )}
                      </div>
                    </li>
                  )}
                />
              </section>
            ),
          )}
        </div>
      )}
    </section>
  );
}
