import type { TranslateBody } from '@projekt-manga/schemas';
import { request } from './client.js';

/** Whether this server can translate pages, and with which service. */
export interface TranslateStatus {
  enabled: boolean;
  provider: 'libretranslate' | 'deepl' | null;
  source: 'ja';
}

export const getTranslateStatus = (signal?: AbortSignal) =>
  request<TranslateStatus>('/translate/status', { signal });

/** Japanese text read off a page, translated in the same order. */
export const translateTexts = (body: TranslateBody, signal?: AbortSignal) =>
  request<{ translations: string[] }>('/translate', { method: 'POST', body, signal });
