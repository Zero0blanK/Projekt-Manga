import type { SuwayomiEngineSettingsBody, SuwayomiSettingsBody } from '@projekt-manga/schemas';
import { request } from './client.js';
import type {
  ExtensionEngineRepository,
  ExtensionEngineStatus,
  SuwayomiConnectionTest,
  SuwayomiExtension,
  SuwayomiMode,
  SuwayomiSettings,
} from '@projekt-manga/types';
export type {
  EngineDownloadProgress,
  ExtensionEngineRepository,
  ExtensionEngineStatus,
  SuwayomiConnectionTest,
  SuwayomiExtension,
  SuwayomiMode,
  SuwayomiSettings,
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

/** Chooses where Suwayomi sources come from. Choosing the built-in engine starts it when
 * it's installed; anything else stops it. */
export const setSuwayomiMode = (mode: SuwayomiMode) =>
  request<SuwayomiSettings>('/suwayomi/mode', { method: 'PUT', body: { mode } });

// The built-in extension engine. Downloads run on the server in the background; their
// progress is in the status, which changes are announced for on the library stream.

export const getExtensionEngine = (signal?: AbortSignal) =>
  request<ExtensionEngineStatus>('/suwayomi/engine', { signal, cache: 'no-store' });

export const installExtensionEngine = () =>
  request<ExtensionEngineStatus>('/suwayomi/engine/install', { method: 'POST' });

export const updateExtensionEngine = () =>
  request<ExtensionEngineStatus>('/suwayomi/engine/update', { method: 'POST' });

export const cancelExtensionEngineDownload = () =>
  request<ExtensionEngineStatus>('/suwayomi/engine/cancel', { method: 'POST' });

/** Looks for newer versions; installs nothing. */
export const checkExtensionEngineUpdates = () =>
  request<ExtensionEngineStatus>('/suwayomi/engine/check-updates', { method: 'POST' });

export const startExtensionEngine = () =>
  request<ExtensionEngineStatus>('/suwayomi/engine/start', { method: 'POST' });

export const stopExtensionEngine = () =>
  request<ExtensionEngineStatus>('/suwayomi/engine/stop', { method: 'POST' });

/** Removes the engine; `keepData` keeps its extensions and their settings. */
export const removeExtensionEngine = (keepData: boolean) =>
  request<ExtensionEngineStatus>('/suwayomi/engine', {
    method: 'DELETE',
    query: { keep_data: keepData ? 'true' : 'false' },
  });

export const saveExtensionEngineSettings = (body: SuwayomiEngineSettingsBody) =>
  request<ExtensionEngineStatus>('/suwayomi/engine/settings', { method: 'PUT', body });

export const getExtensionEngineRepositories = (signal?: AbortSignal) =>
  request<ExtensionEngineRepository[]>('/suwayomi/engine/repositories', {
    signal,
    cache: 'no-store',
  });

export const saveExtensionEngineRepositories = (repositories: string[]) =>
  request<ExtensionEngineRepository[]>('/suwayomi/engine/repositories', {
    method: 'PUT',
    body: { repositories },
  });
