const FALLBACK_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0';

type UserAgentState = {
  browserUserAgent: string | null;
  remoteUserAgent: string | null;
  remoteUpdatedAt: number;
  initialized: boolean;
  refreshTimer: NodeJS.Timeout | null;
};

const IMAGE_ACCEPT = 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8';
const IMAGE_REFERERS: Record<string, string> = {
  mangadex: 'https://mangadex.org/',
  nhentai: 'https://nhentai.net/',
  kissmanga: 'https://kissmanga.in/',
  mangageko: 'https://mgeko.cc/',
  mangatx: 'https://mangatx.cc/',
};

const USER_AGENT_SOURCE_URL =
  process.env.USER_AGENT_SOURCE_URL?.trim() ||
  process.env.IMAGE_PROXY_USER_AGENT_SOURCE_URL?.trim();
const USER_AGENT_REFRESH_INTERVAL_MS = Number.parseInt(
  process.env.USER_AGENT_REFRESH_INTERVAL_MS?.trim() || '',
  10,
);
const DEFAULT_REFRESH_INTERVAL_MS = 1000 * 60 * 60;

const state: UserAgentState = {
  browserUserAgent: null,
  remoteUserAgent: null,
  remoteUpdatedAt: 0,
  initialized: false,
  refreshTimer: null,
};

function normalizeUserAgent(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length >= 20 ? trimmed : null;
}

function pickFromUserAgentList(list: unknown): string | null {
  if (!Array.isArray(list)) {
    return null;
  }

  const valid = list
    .map((entry) => normalizeUserAgent(entry))
    .filter((entry): entry is string => entry !== null);

  if (valid.length === 0) {
    return null;
  }

  return valid[Math.floor(Math.random() * valid.length)]!;
}

function extractUserAgent(payload: unknown): string | null {
  if (typeof payload === 'string') {
    return normalizeUserAgent(payload);
  }

  if (Array.isArray(payload)) {
    return pickFromUserAgentList(payload);
  }

  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const candidate = payload as Record<string, unknown>;
  return (
    normalizeUserAgent(candidate.userAgent) ||
    normalizeUserAgent(candidate.user_agent) ||
    normalizeUserAgent(candidate.ua) ||
    normalizeUserAgent(candidate.user_agent_string) ||
    normalizeUserAgent(candidate.value) ||
    pickFromUserAgentList(candidate.user) ||
    pickFromUserAgentList(candidate.userAgents) ||
    pickFromUserAgentList(candidate.user_agents) ||
    (candidate.data && typeof candidate.data === 'object' ? extractUserAgent(candidate.data) : null)
  );
}

export function setBrowserUserAgent(userAgent: string): void {
  const normalized = normalizeUserAgent(userAgent);
  if (!normalized) {
    return;
  }

  state.browserUserAgent = normalized;
}

async function fetchLatestUserAgentFromWebsite(): Promise<string | null> {
  if (!USER_AGENT_SOURCE_URL) {
    return null;
  }

  const response = await fetch(USER_AGENT_SOURCE_URL, {
    headers: {
      Accept: 'application/json,text/plain;q=0.9,*/*;q=0.8',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch user agent source: ${response.status}`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return extractUserAgent((await response.json()) as unknown);
  }

  const text = await response.text();
  return normalizeUserAgent(text);
}

export async function refreshUserAgentFromWebsite(): Promise<string | null> {
  try {
    const remoteUserAgent = await fetchLatestUserAgentFromWebsite();
    if (!remoteUserAgent) {
      return state.remoteUserAgent;
    }

    state.remoteUserAgent = remoteUserAgent;
    state.remoteUpdatedAt = Date.now();
    return remoteUserAgent;
  } catch (error) {
    console.error('Failed to refresh remote user agent:', error);
    return state.remoteUserAgent;
  }
}

function getFallbackUserAgent(): string {
  return process.env.IMAGE_PROXY_USER_AGENT?.trim() || FALLBACK_USER_AGENT;
}

// browserUserAgent (the last inbound request's UA, set by captureUserAgent middleware)
// wins over remoteUserAgent and the static fallback: an ordinary visitor's UA string looks
// more like a real browser to sources than the periodically-fetched/hardcoded fallback
// does. This is single-server, best-effort state — one process-wide value shared by every
// outbound scrape/image-proxy request, not scoped per request, and it can be set by any
// unauthenticated caller since it just mirrors whatever UA showed up last.
export function getServerUserAgent(): string {
  return state.browserUserAgent || state.remoteUserAgent || getFallbackUserAgent();
}

/** Whether the server already knows the right Referer for a source's images. */
export function hasImageReferer(sourceId: string): boolean {
  return Object.prototype.hasOwnProperty.call(IMAGE_REFERERS, sourceId);
}

export function createImageRequestHeaders(
  sourceId?: string,
  extraHeaders: Record<string, string> = {},
) {
  return {
    'User-Agent': getServerUserAgent(),
    Accept: IMAGE_ACCEPT,
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    ...(sourceId && IMAGE_REFERERS[sourceId] ? { Referer: IMAGE_REFERERS[sourceId] } : {}),
    ...extraHeaders,
  } as const;
}

export function initializeUserAgentRefresh(): void {
  if (state.initialized) {
    return;
  }

  state.initialized = true;

  if (!USER_AGENT_SOURCE_URL) {
    return;
  }

  void refreshUserAgentFromWebsite();

  const refreshIntervalMs =
    Number.isFinite(USER_AGENT_REFRESH_INTERVAL_MS) && USER_AGENT_REFRESH_INTERVAL_MS > 0
      ? USER_AGENT_REFRESH_INTERVAL_MS
      : DEFAULT_REFRESH_INTERVAL_MS;

  state.refreshTimer = setInterval(() => {
    void refreshUserAgentFromWebsite();
  }, refreshIntervalMs);

  state.refreshTimer.unref?.();
}
