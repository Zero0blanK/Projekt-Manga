// Request header factories: general, navigation (adds Sec-Fetch-* anti-detection headers)
// and image requests. Each accepts header overrides.

import { getUserAgentManager } from '../features/UserAgentManager.js';

type HeaderOverrides = Record<string, string>;

const FALLBACK_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0';

export function getRequestUserAgent(): string {
  try {
    return getUserAgentManager().getCurrentProfile().userAgent;
  } catch {
    return FALLBACK_UA;
  }
}

export function createReqConfig(headerOverrides: HeaderOverrides = {}) {
  return {
    method: 'GET' as const,
    headers: {
      'User-Agent': getRequestUserAgent(),
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
      ...headerOverrides,
    },
  } as const;
}

export function createNavReqConfig(headerOverrides: HeaderOverrides = {}) {
  const reqConfig = createReqConfig();
  return {
    method: 'GET' as const,
    headers: {
      ...reqConfig.headers,
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      ...headerOverrides,
    },
  } as const;
}

export function createImageReqConfig(headerOverrides: HeaderOverrides = {}) {
  return {
    method: 'GET' as const,
    headers: {
      'User-Agent': getRequestUserAgent(),
      Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
      ...headerOverrides,
    },
  } as const;
}

// Static exports are computed once at module load, so they freeze the User-Agent for the
// process lifetime; prefer calling the create*ReqConfig() factories per request.
export const ReqConfig = createReqConfig();
export const NavReqConfig = createNavReqConfig();
export const ImageReqConfig = createImageReqConfig();
