'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  ApiError,
  addExtensionRepository,
  deleteExtensionRepository,
  deleteInstalledExtension,
  installExtension,
  listExtensionRepositories,
  listInstalledExtensions,
  refreshExtensionRepository,
  updateInstalledExtension,
  type ExtensionRepositoryWithListing,
  type InstalledExtension,
} from '@projekt-manga/api-client';
import { UNSIGNED_REPOSITORY_ERROR, type ExtensionListingEntry } from '@projekt-manga/schemas';
import { invalidateSourceDependentQueries, queryClient, queryKeys } from './query-client';
import { clearStaticDataCache, staticDataQueries } from './startup-static-data';

/**
 * Repositories and installed extensions, and the actions that change them.
 *
 * Kept out of `library-store.ts` because that file is about the reader's library and the
 * catalogs behind it; this is about which code the app runs. They meet in exactly one
 * place — installing a source changes what `useSources()` returns — which is
 * `invalidateSourceDependentQueries()`'s whole job.
 *
 * These live in react-query rather than component state so every consumer shares one
 * cache. A panel-local copy would leave Discover reading a cache nobody told about an
 * install, so the source would stay invisible until the app restarted. One cache,
 * invalidated in one place, avoids that.
 */

const EMPTY_REPOSITORIES: ExtensionRepositoryWithListing[] = [];
const EMPTY_INSTALLED: InstalledExtension[] = [];
const pendingInstalls = new Map<string, Promise<void>>();

/**
 * Every added repository, each with the source listing fetched from its index URL.
 *
 * The server re-fetches every repository's index to answer this, so it is a network call
 * per repository — hence the long staleTime. A repository that cannot be reached comes
 * back with `fetchError` set and `sources: []` rather than failing the whole query, so one
 * dead repository never hides the others.
 */
export function useExtensionRepositories() {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const { data, isPending, error, refetch } = useQuery({
    ...staticDataQueries.repositories,
  });

  return {
    repositories: hydrated ? (data ?? EMPTY_REPOSITORIES) : EMPTY_REPOSITORIES,
    loading: !hydrated || isPending,
    error,
    refetch,
  };
}

export function useInstalledExtensions() {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const { data, isPending, error } = useQuery({
    ...staticDataQueries.installedExtensions,
  });

  return {
    installed: hydrated ? (data ?? EMPTY_INSTALLED) : EMPTY_INSTALLED,
    loading: !hydrated || isPending,
    error,
  };
}

/** One installable source, resolved against what is already installed. */
export interface CatalogEntry {
  repositoryId: string;
  repositoryName: string;
  entry: ExtensionListingEntry;
  /** The installed row's id when this exact source is installed, else null. */
  installedId: string | null;
  /**
   * Another repository already provides this `source_key`.
   *
   * The database is unique on (repository_id, source_key), so a second repository
   * offering the same key *can* be installed — and then two sources share one id, which
   * the server resolves by dropping the later one (see
   * sandboxedSourceRegistry.service.ts's getInstalledSandboxedSources). Surfacing it here
   * means the reader is told why they cannot install it, instead of installing something
   * that silently never loads.
   */
  conflictsWithInstalled: boolean;
  /**
   * The repository is publishing different bytes than the installed copy.
   *
   * Compared on the bundle hash rather than the version string because a repository can
   * republish without bumping its version — the hash is what actually changed. A listing
   * that publishes no hash cannot be compared, and reports no update rather than a false
   * one.
   */
  updateAvailable: boolean;
}

export interface SourceCatalog {
  repositories: ExtensionRepositoryWithListing[];
  entries: CatalogEntry[];
  installed: InstalledExtension[];
  loading: boolean;
  /** True once both queries have resolved and no repository has been added yet. */
  hasNoRepositories: boolean;
}

/**
 * The installable-sources view: every repository's listing, annotated with install state.
 *
 * Derived here rather than in the component so the "is this installed / is it an update /
 * does it collide" rules live next to the data they read, and so Discover and any future
 * caller cannot disagree about them.
 */
export function useSourceCatalog(): SourceCatalog {
  const { repositories, loading: reposLoading } = useExtensionRepositories();
  const { installed, loading: installedLoading } = useInstalledExtensions();

  const installedByRepoAndKey = new Map(
    installed.map((row) => [`${row.repository_id}:${row.source_key}`, row]),
  );
  const installedKeys = new Set(installed.map((row) => row.source_key));

  const entries: CatalogEntry[] = repositories.flatMap((repository) =>
    repository.sources.map((entry) => {
      const installedRow = installedByRepoAndKey.get(`${repository.id}:${entry.source_key}`);
      return {
        repositoryId: repository.id,
        repositoryName: repository.name || repository.url,
        entry,
        installedId: installedRow?.id ?? null,
        conflictsWithInstalled: !installedRow && installedKeys.has(entry.source_key),
        updateAvailable: Boolean(
          installedRow &&
          entry.bundle?.sha256 &&
          entry.bundle.sha256 !== installedRow.source_code_hash,
        ),
      };
    }),
  );

  const loading = reposLoading || installedLoading;
  return {
    repositories,
    entries,
    installed,
    loading,
    hasNoRepositories: !loading && repositories.length === 0,
  };
}

/**
 * Mutations, as plain functions so they can be called from event handlers.
 *
 * Every one that can change the installed set ends in
 * `invalidateSourceDependentQueries()`; the ones that only touch repositories invalidate
 * just that list. Errors are re-thrown rather than swallowed: the caller owns the toast,
 * and the server's message is more specific than anything this layer could invent
 * ("already installed", "needs a newer app", "checksum mismatch").
 */
export const extensionActions = {
  async addRepository(url: string): Promise<void> {
    await addExtensionRepository({ url: url.trim() });
    clearStaticDataCache();
    await queryClient.invalidateQueries({ queryKey: queryKeys.extensionRepositories });
  },

  /** Removing a repository uninstalls everything that came from it, server-side. */
  async removeRepository(id: string): Promise<void> {
    await deleteExtensionRepository(id);
    clearStaticDataCache();
    await invalidateSourceDependentQueries();
  },

  async refreshRepository(id: string): Promise<void> {
    await refreshExtensionRepository(id);
    clearStaticDataCache();
    await queryClient.invalidateQueries({ queryKey: queryKeys.extensionRepositories });
  },

  /** `confirmUnsigned` is asked when the server says the repository is not signed; the
   * install is retried with the acknowledgement only if it resolves true. */
  async install(
    repositoryId: string,
    sourceKey: string,
    confirmUnsigned?: () => Promise<boolean>,
  ): Promise<void> {
    const key = `${repositoryId}:${sourceKey}`;
    const existing = pendingInstalls.get(key);
    if (existing) return existing;
    const request = (async () => {
      try {
        await installExtension({ repository_id: repositoryId, source_key: sourceKey });
      } catch (error) {
        const unsigned =
          error instanceof ApiError &&
          error.status === 409 &&
          error.message.startsWith(UNSIGNED_REPOSITORY_ERROR);
        if (!unsigned || !confirmUnsigned || !(await confirmUnsigned())) throw error;
        await installExtension({
          repository_id: repositoryId,
          source_key: sourceKey,
          acknowledge_unsigned: true,
        });
      }
      clearStaticDataCache();
      await invalidateSourceDependentQueries();
    })();
    pendingInstalls.set(key, request);
    try {
      await request;
    } finally {
      pendingInstalls.delete(key);
    }
  },

  async uninstall(installedId: string): Promise<void> {
    await deleteInstalledExtension(installedId);
    clearStaticDataCache();
    await invalidateSourceDependentQueries();
  },

  /** Resolves to whether the update actually replaced anything. */
  async checkForUpdate(installedId: string): Promise<boolean> {
    const result = await updateInstalledExtension(installedId);
    clearStaticDataCache();
    // Invalidated even when unchanged: the server stamps last_checked_at either way, and
    // an unchanged result still refreshes the "update available" badge this drives.
    await invalidateSourceDependentQueries();
    return result.changed;
  },
};
