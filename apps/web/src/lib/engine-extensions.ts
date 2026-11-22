'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ApiError,
  changeSuwayomiExtension,
  getSuwayomiExtensions,
  getSuwayomiSettings,
  type SuwayomiExtension,
} from '@projekt-manga/api-client';
import { queryClient as client, queryKeys } from '@/lib/query-client';
import { sourceLanguageGroup } from '@/lib/source-language';
import type { DiscoverFilters } from '@/lib/discover-filters';
import { toast } from '@/hooks/use-toast';

/**
 * The extension engine's extensions (the built-in engine, or a Suwayomi server of the
 * reader's own), as Discover › Extensions lists them beside the repositories' sources.
 *
 * They are shown by their author rather than by the program that runs them: these are
 * the KEI extensions, so every row from the engine is credited to `@KEI`.
 */
export const ENGINE_AUTHOR = '@KEI';

const EXTENSIONS_KEY = ['suwayomi', 'extensions'] as const;

export const engineErrorText = (error: unknown, fallback: string) =>
  error instanceof ApiError && error.message ? error.message : fallback;

/**
 * The extension engine's extensions: whether there is one this reader may manage (the
 * endpoints are admin-only, like extension repositories), and its list once loaded.
 * `active` false asks nothing of the server, for a list that isn't showing the engine.
 */
export function useSuwayomiExtensions(active = true) {
  const settings = useQuery(
    {
      queryKey: ['suwayomi', 'settings'],
      queryFn: ({ signal }) => getSuwayomiSettings(signal),
      enabled: active,
      retry: false,
    },
    client,
  );
  const builtIn = settings.data?.mode === 'built-in';
  const enabled =
    active && (builtIn || (settings.data?.mode !== 'off' && settings.data?.enabled === true));
  const list = useQuery(
    {
      queryKey: EXTENSIONS_KEY,
      queryFn: ({ signal }) => getSuwayomiExtensions(false, signal),
      enabled,
      retry: false,
    },
    client,
  );
  return { enabled, builtIn, list };
}

/** Whether an engine extension passes Discover's name, language, rating and adult filters. */
export function matchesEngineFilters(
  extension: SuwayomiExtension,
  name: string,
  filters: Pick<DiscoverFilters, 'language' | 'rating'>,
  hideAdult: boolean,
): boolean {
  const needle = name.trim().toLocaleLowerCase();
  return (
    (!hideAdult || !extension.is_nsfw) &&
    extension.name.toLocaleLowerCase().includes(needle) &&
    (!filters.language || sourceLanguageGroup(extension.lang) === filters.language) &&
    // The engine only says whether an extension is adult; it has no "mixed".
    (!filters.rating ||
      (filters.rating === 'nsfw'
        ? extension.is_nsfw
        : filters.rating === 'safe' && !extension.is_nsfw))
  );
}

/**
 * Installing, updating and removing an engine extension, and re-reading the engine's list.
 * Busy state is per extension, so one install doesn't freeze every other row.
 */
export function useEngineExtensionActions() {
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());

  /** Re-reads the engine's extension list. Throws on failure, for the caller to report. */
  const refresh = async () => {
    client.setQueryData(EXTENSIONS_KEY, await getSuwayomiExtensions(true));
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
        description: `${extension.name} ${action === 'install' ? 'installed' : action === 'update' ? 'updated' : 'removed'}.`,
      });
    } catch (error) {
      toast({ description: engineErrorText(error, `Couldn't change ${extension.name}.`) });
    } finally {
      setBusy((current) => {
        const next = new Set(current);
        next.delete(extension.pkg_name);
        return next;
      });
    }
  };

  return { busy, change, refresh };
}
