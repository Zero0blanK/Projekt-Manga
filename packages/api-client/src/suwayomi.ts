import type { SuwayomiSettingsBody } from '@projekt-manga/schemas';
import { request } from './client.js';
import type {
  SuwayomiSettings,
  SuwayomiConnectionTest,
  SuwayomiExtension,
} from '@projekt-manga/types';
export type {
  SuwayomiSettings,
  SuwayomiConnectionTest,
  SuwayomiExtension,
} from '@projekt-manga/types';

export const getSuwayomiSettings = (signal?: AbortSignal) =>
  request<SuwayomiSettings | null>('/suwayomi/settings', { signal, cache: 'no-store' });

/** Saves the connection. Leave `password` out to keep the saved one. */
export const saveSuwayomiSettings = (body: SuwayomiSettingsBody) =>
  request<SuwayomiSettings>('/suwayomi/settings', { method: 'PUT', body });

export const removeSuwayomiSettings = () =>
  request<null>('/suwayomi/settings', { method: 'DELETE' });

/** Tries the saved connection: the server's name and version, and how many sources it has. */
export const testSuwayomiConnection = () =>
  request<SuwayomiConnectionTest>('/suwayomi/test', { method: 'POST' });

/** Merges the Suwayomi server's library into this one, in the background. */
export const importSuwayomiLibrary = () =>
  request<{ id: string; titles: number }>('/suwayomi/import', { method: 'POST' });

/** Every extension in the server's repositories. `refresh` re-reads those repositories. */
export const getSuwayomiExtensions = (refresh = false, signal?: AbortSignal) =>
  request<SuwayomiExtension[]>('/suwayomi/extensions', {
    signal,
    cache: 'no-store',
    ...(refresh ? { query: { refresh: 1 } } : {}),
  });

export const changeSuwayomiExtension = (
  pkgName: string,
  action: 'install' | 'update' | 'uninstall',
) =>
  request<SuwayomiExtension | null>(`/suwayomi/extensions/${encodeURIComponent(pkgName)}`, {
    method: 'POST',
    body: { action },
  });
