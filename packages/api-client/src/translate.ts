import type {
  TranslateBody,
  TranslateProvider,
  TranslateSettingsBody,
} from '@projekt-manga/schemas';
import { request } from './client.js';

/** Whether pages can be translated for this reader, and with which service. */
export interface TranslateStatus {
  enabled: boolean;
  provider: TranslateProvider | null;
  /** Whose service answers: the reader's own saved one, or the host's. Older servers omit it. */
  origin?: 'account' | 'server' | null;
  /** Whether the host set a service of its own. Older servers omit it. */
  server_configured?: boolean;
  source: 'ja';
}

export const getTranslateStatus = (signal?: AbortSignal) =>
  request<TranslateStatus>('/translate/status', { signal });

/** Japanese text read off a page, translated in the same order. */
export const translateTexts = (body: TranslateBody, signal?: AbortSignal) =>
  request<{ translations: string[] }>('/translate', { method: 'POST', body, signal });

/** The reader's own translation service. The API key is never sent back: only `has_key`. */
export interface TranslateSettings {
  provider: TranslateProvider;
  url: string | null;
  has_key: boolean;
  /** False when the saved key can no longer be decrypted and has to be entered again. */
  key_readable: boolean;
  updated_at: string;
}

export const getTranslateSettings = (signal?: AbortSignal) =>
  request<TranslateSettings | null>('/translate/settings', { signal });

/** Saves the service. Leave `api_key` out to keep the saved key. */
export const saveTranslateSettings = (body: TranslateSettingsBody) =>
  request<TranslateSettings>('/translate/settings', { method: 'PUT', body });

export const removeTranslateSettings = () =>
  request<null>('/translate/settings', { method: 'DELETE' });
