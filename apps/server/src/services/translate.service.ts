import type { TranslateBody, TranslateTarget } from '@projekt-manga/schemas';
import { AppError, ServiceUnavailableError, UpstreamError } from '../utils/customErrors.js';
import { guardedFetch } from '../utils/guardedFetch.js';
import { UnsafeUrlError, assertPublicHttpUrl } from '../utils/ssrfGuard.js';
import translationSettings from './translationSetting.service.js';
import localTranslation from './localTranslation.service.js';
import { localTranslationEnabled } from './translationModels.service.js';

/**
 * Reader › Translate page. The device reads the Japanese text off the page (OCR in the
 * browser); this sends only that text to a translation service and returns the
 * translations in the same order.
 *
 * The service is the reader's own, saved in Settings (translationSetting.service.ts), or
 * else the one the host set in the environment. The host's is trusted and called with a
 * plain fetch (a self-hosted LibreTranslate is usually on localhost). A reader's saved
 * address is not: it only reaches public addresses, unless the host sets
 * TRANSLATE_ALLOW_PRIVATE_HOSTS=true (the desktop app does, since its reader is its host).
 * Redirects are refused so the key never follows one, and errors name the service's
 * status only.
 *
 * With neither, English is translated on this server itself (localTranslation.service.ts),
 * unless the host turned that off with LOCAL_TRANSLATION=off.
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
  provider: Provider | 'local';
  url: string;
  key?: string;
  /** Where it came from: the reader's own settings, the host's environment, or this server's
   * own models. */
  origin: 'account' | 'server' | 'local';
}

const LOCAL: Config = { provider: 'local', url: 'local', origin: 'local' };

function complete(
  provider: Provider | undefined,
  url: string | undefined,
  key: string | undefined,
  origin: Config['origin'],
): Config | null {
  if (provider === 'libretranslate') return url ? { provider, url, key, origin } : null;
  if (provider === 'deepl') {
    if (!key) return null;
    return { provider, key, origin, url: url ?? (key.endsWith(':fx') ? DEEPL_FREE : DEEPL_PRO) };
  }
  return null;
}

/** The host's service from the environment, or null when it set none. */
function serverConfig(): Config | null {
  return complete(
    process.env.TRANSLATE_PROVIDER as Provider | undefined,
    process.env.TRANSLATE_URL || undefined,
    process.env.TRANSLATE_API_KEY || undefined,
    'server',
  );
}

/** The service for this identity: its own saved one first, then the host's. */
async function config(user_id: string | null): Promise<Config | null> {
  const saved = await translationSettings.resolve(user_id);
  const own = saved && complete(saved.provider, saved.url ?? undefined, saved.key, 'account');
  return own ?? serverConfig() ?? (localTranslationEnabled() ? LOCAL : null);
}

/** Sends to a reader-supplied address only with the public-address checks. */
async function send(service: Config, url: URL, init: RequestInit): Promise<Response> {
  if (service.origin === 'server' || process.env.TRANSLATE_ALLOW_PRIVATE_HOSTS === 'true')
    return fetch(url, init);
  await assertPublicHttpUrl(url.href);
  return guardedFetch(url, init);
}

function refusedAddress(error: unknown): boolean {
  for (let cause = error, depth = 0; cause && depth < 5; depth++) {
    if (cause instanceof UnsafeUrlError) return true;
    cause = (cause as { cause?: unknown }).cause;
  }
  return false;
}

class RateLimitedError extends AppError {
  constructor() {
    super('Too many translations at once; try again in a minute', 429, 'RateLimitedError');
  }
}

const recent = new Map<string, number[]>();
const RECENT_IDENTITIES_LIMIT = 1000;

function checkRate(identity: string) {
  const now = Date.now();
  const times = (recent.get(identity) ?? []).filter((at) => now - at < RATE_WINDOW_MS);
  if (times.length >= RATE_LIMIT) throw new RateLimitedError();
  times.push(now);
  recent.set(identity, times);
  if (recent.size > RECENT_IDENTITIES_LIMIT) forgetIdleIdentities(now);
}

/** Identities are per IP, so an entry that's aged out would otherwise stay forever. */
function forgetIdleIdentities(now: number) {
  for (const [identity, times] of recent) {
    if (!times.some((at) => now - at < RATE_WINDOW_MS)) recent.delete(identity);
  }
}

// The same bubble text comes up again (re-reading, a recurring line): translated once.
// Keyed by the service too: two readers' services can translate the same line differently.
const cache = new Map<string, string>();
const cacheKey = (service: Config, target: string, text: string) =>
  `${service.provider}\u0000${service.url}\u0000${target}\u0000${text}`;

function remember(key: string, value: string) {
  cache.set(key, value);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
}

/** Reading bubbles (local OCR) is limited like translating, counted on its own. */
export function checkReadRate(identity: string) {
  checkRate(`read:${identity}`);
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
  if (service.provider === 'local') {
    if (target !== 'en')
      throw new ServiceUnavailableError(
        'Translation on this computer is English only. For other languages, add DeepL or LibreTranslate in Settings › Reader › Page translation',
      );
    return localTranslation.translate(texts);
  }
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
    response = await send(service, url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError')
      throw new UpstreamError('The translation service timed out');
    if (refusedAddress(error))
      throw new UpstreamError(
        'The translation service address is not public (see TRANSLATE_ALLOW_PRIVATE_HOSTS)',
      );
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
  async status(user_id: string | null) {
    const service = await config(user_id);
    return {
      enabled: !!service,
      provider: service?.provider ?? null,
      /** Whose service answers: the reader's own, or the host's. */
      origin: service?.origin ?? null,
      server_configured: serverConfig() !== null,
      source: 'ja' as const,
    };
  },

  async translate(body: TranslateBody, identity: string, user_id: string | null) {
    const service = await config(user_id);
    if (!service)
      throw new ServiceUnavailableError(
        'Translation is not set up. Add a service in Settings › Reader › Page translation',
      );
    const missing = [
      ...new Set(body.texts.filter((text) => !cache.has(cacheKey(service, body.target, text)))),
    ];
    if (missing.length > 0) {
      checkRate(identity);
      const translated = await call(service, missing, body.target);
      missing.forEach((text, index) =>
        remember(cacheKey(service, body.target, text), translated[index]),
      );
    }
    return {
      translations: body.texts.map((text) => cache.get(cacheKey(service, body.target, text)) ?? ''),
    };
  },
};
