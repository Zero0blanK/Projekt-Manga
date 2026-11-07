import { buildApiUrl, request } from './client.js';
import type {
  AddExtensionRepositoryBody,
  InstallExtensionBody,
  ExtensionListingEntry,
} from '@projekt-manga/schemas';
import type { ExtensionRepository, InstalledExtension } from '@projekt-manga/types';
export type { ExtensionRepository, InstalledExtension } from '@projekt-manga/types';

/** Stays here: its listing entries are defined by the schema that validates them. */
export interface ExtensionRepositoryWithListing extends ExtensionRepository {
  sources: ExtensionListingEntry[];
  fetchError: string | null;
}

export const listExtensionRepositories = (signal?: AbortSignal) =>
  request<ExtensionRepositoryWithListing[]>('/extensions/repositories', { signal });

export const addExtensionRepository = (body: AddExtensionRepositoryBody) =>
  request<ExtensionRepository>('/extensions/repositories', { method: 'POST', body });

export const refreshExtensionRepository = (id: string) =>
  request<ExtensionRepositoryWithListing>(
    `/extensions/repositories/${encodeURIComponent(id)}/refresh`,
    { method: 'POST' },
  );

export const deleteExtensionRepository = (id: string) =>
  request<null>(`/extensions/repositories/${encodeURIComponent(id)}`, { method: 'DELETE' });

export const listInstalledExtensions = (signal?: AbortSignal) =>
  request<InstalledExtension[]>('/extensions/installed', { signal });

export const installExtension = (body: InstallExtensionBody) =>
  request<InstalledExtension>('/extensions/installed', { method: 'POST', body });

export const updateInstalledExtension = (id: string) =>
  request<{ installed: InstalledExtension; changed: boolean }>(
    `/extensions/installed/${encodeURIComponent(id)}/update`,
    {
      method: 'POST',
    },
  );

/** URL for an <img src>: the icon stored with the installed source, so it shows offline. */
export const buildInstalledExtensionIconUrl = (id: string) =>
  buildApiUrl(`/extensions/installed/${encodeURIComponent(id)}/icon`);

export const deleteInstalledExtension = (id: string) =>
  request<null>(`/extensions/installed/${encodeURIComponent(id)}`, { method: 'DELETE' });
