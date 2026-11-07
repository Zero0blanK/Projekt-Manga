import type { TranslateBody, TranslateSettingsBody } from '@projekt-manga/schemas';
import { request } from './client.js';
import type { TranslateStatus, TranslateSettings } from '@projekt-manga/types';
export type { TranslateStatus, TranslateSettings } from '@projekt-manga/types';

export const getTranslateStatus = (signal?: AbortSignal) =>
  request<TranslateStatus>('/translate/status', { signal });

/** Japanese text read off a page, translated in the same order. */
export const translateTexts = (body: TranslateBody, signal?: AbortSignal) =>
  request<{ translations: string[] }>('/translate', { method: 'POST', body, signal });

export const getTranslateSettings = (signal?: AbortSignal) =>
  request<TranslateSettings | null>('/translate/settings', { signal });

/** Saves the service. Leave `api_key` out to keep the saved key. */
export const saveTranslateSettings = (body: TranslateSettingsBody) =>
  request<TranslateSettings>('/translate/settings', { method: 'PUT', body });

export const removeTranslateSettings = () =>
  request<null>('/translate/settings', { method: 'DELETE' });
