import type {
  TranslateBody,
  TranslatePageBody,
  TranslateReadBody,
  TranslateSettingsBody,
} from '@projekt-manga/schemas';
import { translateProviders } from '@projekt-manga/schemas';
import { request } from './client.js';
import type {
  LocalTranslationStatus,
  TranslateStatus,
  TranslateSettings,
} from '@projekt-manga/types';
export type {
  LocalTranslationStatus,
  TranslateStatus,
  TranslateSettings,
} from '@projekt-manga/types';

export const getTranslateStatus = (signal?: AbortSignal) =>
  request<TranslateStatus>('/translate/status', { signal });

/** Japanese text read off a page, translated in the same order. */
export const translateTexts = (body: TranslateBody, signal?: AbortSignal) =>
  request<{ translations: string[] }>('/translate', { method: 'POST', body, signal });

/**
 * A reply without a provider this client knows (an empty object, an older or newer server)
 * reads as no service chosen, and the optional fields get their defaults.
 */
export const normalizeTranslateSettings = (reply: unknown): TranslateSettings | null => {
  if (!reply || typeof reply !== 'object') return null;
  const value = reply as Partial<Record<keyof TranslateSettings, unknown>>;
  if (!(translateProviders as readonly unknown[]).includes(value.provider)) return null;
  return {
    provider: value.provider as TranslateSettings['provider'],
    url: typeof value.url === 'string' ? value.url : null,
    has_key: value.has_key === true,
    key_readable: value.key_readable !== false,
    updated_at: typeof value.updated_at === 'string' ? value.updated_at : '',
  };
};

export const getTranslateSettings = (signal?: AbortSignal) =>
  request<unknown>('/translate/settings', { signal }).then(normalizeTranslateSettings);

/** Saves the service. Leave `api_key` out to keep the saved key. */
export const saveTranslateSettings = (body: TranslateSettingsBody) =>
  request<TranslateSettings>('/translate/settings', { method: 'PUT', body });

export const removeTranslateSettings = () =>
  request<null>('/translate/settings', { method: 'DELETE' });

/** Local translation's models on the server: whether they are here, or downloading. */
export const getLocalTranslationStatus = (signal?: AbortSignal) =>
  request<LocalTranslationStatus>('/translate/local', { signal });

/** Starts (or joins) downloading local translation's models. */
export const downloadLocalTranslation = () =>
  request<LocalTranslationStatus>('/translate/local/download', { method: 'POST' });

/** The Japanese in one page's speech bubbles, read by the server's manga-ocr. */
export const readBubbleTexts = (body: TranslateReadBody, signal?: AbortSignal) =>
  request<{ texts: string[] }>('/translate/read', { method: 'POST', body, signal });

/**
 * The text on one whole page, found and read by the server's models, with where each
 * translation goes (fractions of the page).
 */
export const readPageRegions = (body: TranslatePageBody, signal?: AbortSignal) =>
  request<{ regions: Array<{ text: string; x: number; y: number; w: number; h: number }> }>(
    '/translate/page',
    { method: 'POST', body, signal },
  );
