import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchRemoteUserAgentString } from '../features/RemoteUserAgent.js';

const REAL_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

function mockJsonResponse(body: unknown, ok = true) {
  return {
    ok,
    status: ok ? 200 : 500,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function mockTextResponse(body: string, ok = true) {
  return {
    ok,
    status: ok ? 200 : 500,
    headers: { get: () => 'text/plain' },
    json: async () => {
      throw new Error('not json');
    },
    text: async () => body,
  };
}

describe('fetchRemoteUserAgentString', () => {
  const originalUrl = process.env.USER_AGENT_SOURCE_URL;

  beforeEach(() => {
    process.env.USER_AGENT_SOURCE_URL = 'https://example.test/ua';
  });

  afterEach(() => {
    process.env.USER_AGENT_SOURCE_URL = originalUrl;
    vi.unstubAllGlobals();
  });

  it('returns null when USER_AGENT_SOURCE_URL is not configured', async () => {
    delete process.env.USER_AGENT_SOURCE_URL;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(await fetchRemoteUserAgentString()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts a plain-text UA response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockTextResponse(REAL_UA)));
    expect(await fetchRemoteUserAgentString()).toBe(REAL_UA);
  });

  it('accepts a JSON object with a userAgent field', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse({ userAgent: REAL_UA })));
    expect(await fetchRemoteUserAgentString()).toBe(REAL_UA);
  });

  it('accepts a JSON object with a snake_case user_agent field', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse({ user_agent: REAL_UA })));
    expect(await fetchRemoteUserAgentString()).toBe(REAL_UA);
  });

  it('accepts a nested { data: { ua } } shape', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse({ data: { ua: REAL_UA } })));
    expect(await fetchRemoteUserAgentString()).toBe(REAL_UA);
  });

  it('accepts a top-level array of UA strings, picking one of the valid entries', async () => {
    const list = [REAL_UA, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15'];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(list)));
    const result = await fetchRemoteUserAgentString();
    expect(list).toContain(result);
  });

  it('accepts the microlink.io { user: string[] } shape', async () => {
    const payload = {
      crawler: ['googlebot'],
      updatedAt: Date.now(),
      user: [REAL_UA],
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(payload)));
    expect(await fetchRemoteUserAgentString()).toBe(REAL_UA);
  });

  it('ignores non-string junk entries inside a UA list', async () => {
    const payload = { user: [123, null, REAL_UA, ''] };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(payload)));
    expect(await fetchRemoteUserAgentString()).toBe(REAL_UA);
  });

  it('returns null when the payload has no recognizable UA field', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse({ unrelated: 'value' })));
    expect(await fetchRemoteUserAgentString()).toBeNull();
  });

  it('returns null for an empty list', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse({ user: [] })));
    expect(await fetchRemoteUserAgentString()).toBeNull();
  });

  it('throws on a non-ok HTTP response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockTextResponse('', false)));
    await expect(fetchRemoteUserAgentString()).rejects.toThrow();
  });

  it('rejects a suspiciously short string as not a real UA', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockTextResponse('short')));
    expect(await fetchRemoteUserAgentString()).toBeNull();
  });
});
