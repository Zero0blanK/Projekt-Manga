// fetchRemoteUserAgentString(): fetches a real-world User-Agent from USER_AGENT_SOURCE_URL
// (the same variable the server uses for its image-proxy UA). Accepts a plain-text body, a
// JSON object with a userAgent-like field, or a JSON object/array holding a list of UA
// strings (e.g. microlink's `{ user: string[] }`), from which one is picked at random.
// Returns null when unconfigured, unreachable, or nothing parses as a real UA.

const FETCH_TIMEOUT_MS = 8000;

function normalizeUserAgent(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length >= 20 && trimmed.length <= 512 ? trimmed : null;
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

export async function fetchRemoteUserAgentString(): Promise<string | null> {
  const sourceUrl = process.env.USER_AGENT_SOURCE_URL?.trim();
  if (!sourceUrl) {
    return null;
  }

  const response = await fetch(sourceUrl, {
    headers: {
      Accept: 'application/json,text/plain;q=0.9,*/*;q=0.8',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch user agent source: ${response.status}`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return extractUserAgent((await response.json()) as unknown);
  }

  return normalizeUserAgent(await response.text());
}
