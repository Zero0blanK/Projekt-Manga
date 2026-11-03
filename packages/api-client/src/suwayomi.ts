import type { SuwayomiSettingsBody } from '@projekt-manga/schemas';
import { request } from './client.js';

/** The host's Suwayomi server connection. The password is never sent back: only
 * `has_password`. */
export interface SuwayomiSettings {
  enabled: boolean;
  url: string;
  username: string | null;
  has_password: boolean;
  /** False when the saved password can no longer be decrypted and has to be entered again. */
  password_readable: boolean;
}

/** What a connection test found on the server. */
export interface SuwayomiConnectionTest {
  name: string;
  version: string;
  sources: number;
}

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

/** A Mihon extension the Suwayomi server can install, installed or not. */
export interface SuwayomiExtension {
  pkg_name: string;
  name: string;
  lang: string;
  version: string;
  icon_url: string | null;
  is_nsfw: boolean;
  installed: boolean;
  has_update: boolean;
  obsolete: boolean;
}

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
