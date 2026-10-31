import type { TranslateBody, TranslateTarget } from '@projekt-manga/schemas';
import { AppError, ServiceUnavailableError, UpstreamError } from '../utils/customErrors.js';

/**
 * Reader › Translate page. The device reads the Japanese text off the page (OCR in the
 * browser); this sends only that text to the translation service the host configured in
 * the environment, and returns the translations in the same order.
 *
 * The service URL and key come from the host's own environment, never from a request, so
 * this uses a plain fetch (a self-hosted LibreTranslate is usually on localhost). Redirects
 * are refused so the key never follows one, and errors name the service's status only.
 */

const TIMEOUT_MS = 20_000;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 30;
const CACHE_LIMIT = 2000;
const DEEPL_FREE = 'https://api-free.deepl.com';
const DEEPL_PRO = 'https://api.deepl.com';

/** DeepL's names for the targets that differ from the two-letter code. */
const DEEPL_TARGETS: Partial<Record<TranslateTarget, string>> = {
  en: 'EN-US',
  pt: 'PT-BR',
  zh: 'ZH-HANS',
};

type Provider = 'libretranslate' | 'deepl';

interface Config {
  provider: Provider;
  url: string;
  key?: string;
}

/** The configured service, or null when translation is off or incomplete. */
function config(): Config | null {
  const provider = process.env.TRANSLATE_PROVIDER as Provider | undefined;
  const key = process.env.TRANSLATE_API_KEY || undefined;
  const url = process.env.TRANSLATE_URL || undefined;
  if (provider === 'libretranslate') return url ? { provider, url, key } : null;
  if (provider === 'deepl') {
    if (!key) return null;
    return { provider, key, url: url ?? (key.endsWith(':fx') ? DEEPL_FREE : DEEPL_PRO) };
  }
  return null;
}

class RateLimitedError extends AppError {
  constructor() {
    super('Too many translations at once; try again in a minute', 429, 'RateLimitedError');
  }
}

const recent = new Map<string, number[]>();

function checkRate(identity: string) {
  const now = Date.now();
  const times = (recent.get(identity) ?? []).filter((at) => now - at < RATE_WINDOW_MS);
  if (times.length >= RATE_LIMIT) throw new RateLimitedError();
  times.push(now);
  recent.set(identity, times);
}

// The same bubble text comes up again (re-reading, a recurring line): translated once.
const cache = new Map<string, string>();
const cacheKey = (target: string, text: string) => `${target}\u0000${text}`;

function remember(key: string, value: string) {
  cache.set(key, value);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
}

/** For tests: forget the rate limit and the cached translations. */
export function resetTranslateState() {
  recent.clear();
  cache.clear();
}

function endpoint(base: string, path: string): URL {
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}${path}`;
  return url;
}

async function call(service: Config, texts: string[], target: TranslateTarget): Promise<string[]> {
  const deepl = service.provider === 'deepl';
  const url = endpoint(service.url, deepl ? '/v2/translate' : '/translate');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (deepl) headers.Authorization = `DeepL-Auth-Key ${service.key}`;
  const body = deepl
    ? {
        text: texts,
        source_lang: 'JA',
        target_lang: DEEPL_TARGETS[target] ?? target.toUpperCase(),
      }
    : {
        q: texts,
        source: 'ja',
        target,
        format: 'text',
        ...(service.key ? { api_key: service.key } : {}),
      };

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError')
      throw new UpstreamError('The translation service timed out');
    throw new UpstreamError("Couldn't reach the translation service");
  }
  if (!response.ok)
    throw new UpstreamError(`The translation service answered HTTP ${response.status}`);

  const data = (await response.json().catch(() => null)) as unknown;
  const out = deepl
    ? (data as { translations?: Array<{ text?: unknown }> } | null)?.translations?.map(
        (entry) => entry.text,
      )
    : (data as { translatedText?: unknown } | null)?.translatedText;
  if (
    !Array.isArray(out) ||
    out.length !== texts.length ||
    !out.every((text): text is string => typeof text === 'string')
  )
    throw new UpstreamError('The translation service returned an unexpected response');
  return out;
}

export default {
  status() {
    const service = config();
    return { enabled: !!service, provider: service?.provider ?? null, source: 'ja' as const };
  },

  async translate(body: TranslateBody, identity: string) {
    const service = config();
    if (!service) throw new ServiceUnavailableError('Translation is not set up on this server');
    const missing = [
      ...new Set(body.texts.filter((text) => !cache.has(cacheKey(body.target, text)))),
    ];
    if (missing.length > 0) {
      checkRate(identity);
      const translated = await call(service, missing, body.target);
      missing.forEach((text, index) => remember(cacheKey(body.target, text), translated[index]));
    }
    return {
      translations: body.texts.map((text) => cache.get(cacheKey(body.target, text)) ?? ''),
    };
  },
};
