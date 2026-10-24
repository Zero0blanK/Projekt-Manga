import { request } from './client.js';
import type {
  AddExtensionRepositoryBody,
  InstallExtensionBody,
  ExtensionListingEntry,
} from '@projekt-manga/schemas';

export interface ExtensionRepository {
  id: string;
  url: string;
  /** From the repository's own `repository` block; null when it publishes none, in which
   * case the UI shows the URL instead. */
  name: string | null;
  badge_label: string | null;
  description: string | null;
  website: string | null;
  added_at: string;
  last_fetched_at: string | null;
  enabled: boolean;
}

export interface ExtensionRepositoryWithListing extends ExtensionRepository {
  sources: ExtensionListingEntry[];
  fetchError: string | null;
}

export interface InstalledExtension {
  id: string;
  repository_id: string;
  source_key: string;
  name: string;
  lang: string;
  base_url: string;
  is_nsfw: boolean;
  /** `safe` | `mixed` | `nsfw`, captured at install time. Null for a row installed before
   * it was recorded — `is_nsfw` is the fallback, and cannot distinguish mixed from safe. */
  content_rating: string | null;
  allowed_hosts: string[];
  version: string;
  api_version: number;
  version_code: number | null;
  entry_url: string;
  description: string | null;
  homepage: string | null;
  icon_url: string | null;
  source_code_hash: string;
  installed_at: string;
  updated_at: string;
  enabled: boolean;
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

export const deleteInstalledExtension = (id: string) =>
  request<null>(`/extensions/installed/${encodeURIComponent(id)}`, { method: 'DELETE' });
