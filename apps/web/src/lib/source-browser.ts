'use client';

import { desktopBridge } from '@/lib/desktop-bridge';
import { ApiError } from '@projekt-manga/api-client';

/** What the desktop app's source window reports once it is closed (main/source-browser.ts). */
export type SourceBrowserResult = {
  saved: boolean;
  /** Seen past its check. Older desktop builds leave it out. */
  passed?: boolean;
  cookieCount: number;
  message: string;
};

type SourceBrowserBridge = {
  openBrowser: (
    sourceId: string,
    options?: { closeWhenPassed?: boolean },
  ) => Promise<{ success: boolean; message: string; data?: SourceBrowserResult }>;
};

/** The desktop bridge, or undefined in a plain browser — which cannot pass a source's
 * browser check on the server's behalf. */
export function sourceBrowserBridge(): SourceBrowserBridge | undefined {
  if (typeof window === 'undefined') return;
  return desktopBridge<{ source: SourceBrowserBridge }>()?.source;
}

export const CHALLENGE_REQUIRED = 'CHALLENGE_REQUIRED';

/** The setting (Settings › Extensions) for opening a source's check window by itself. */
export const AUTO_OPEN_CHALLENGE_SETTING = 'autoOpenSourceChallenge';

/** The query holding what the server has saved for a source's browser session. */
export const sourceSessionKey = (sourceId: string) => ['source-browser-session', sourceId] as const;

/** A source call that failed on a Cloudflare challenge only a real browser can pass. */
export function isChallengeRequired(error: unknown): boolean {
  return error instanceof ApiError && error.code === CHALLENGE_REQUIRED;
}

/** The source windows open now, so a second request for one joins it. */
const openWindows = new Map<string, Promise<SourceBrowserResult>>();

/** Opens the source in the desktop window and resolves once it is closed and saved. A
 * source whose window is already open gets that window, not a second one.
 * `closeWhenPassed` closes it by itself once the site shows past its check. */
export function openSourceBrowser(
  sourceId: string,
  { closeWhenPassed = false }: { closeWhenPassed?: boolean } = {},
): Promise<SourceBrowserResult> {
  const open = openWindows.get(sourceId);
  if (open) return open;
  const opening = (async () => {
    const bridge = sourceBrowserBridge();
    if (!bridge) throw new Error('Opening a source in a browser needs the desktop app.');
    const result = await bridge.openBrowser(sourceId, { closeWhenPassed });
    if (!result.success || !result.data) throw new Error(result.message);
    return result.data;
  })().finally(() => openWindows.delete(sourceId));
  openWindows.set(sourceId, opening);
  return opening;
}

/** The source a failed request was for: `/source/<id>/...`. */
export function sourceIdFromPath(path: string): string | null {
  const id = /\/source\/([^/]+)\//.exec(path)?.[1];
  if (!id || id === 'image-proxy' || id === 'library') return null;
  try {
    return decodeURIComponent(id);
  } catch {
    return null;
  }
}

/** A cookie pasted from the reader's own browser, in the shape the server stores. */
export interface PastedCookie {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  httpOnly: boolean;
}

const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,256}$/;
const COOKIE_VALUE = /^[\x21-\x7e]{0,4096}$/;

/**
 * Reads cookies the reader copied from their browser: a whole `Cookie` header
 * ("cf_clearance=…; other=…", with or without the "Cookie:" prefix) or just the value of
 * `cf_clearance`. They are set on the source's site and its subdomains, as Cloudflare sets
 * its clearance. Throws with a reason the reader can act on.
 */
export function parsePastedCookies(text: string, siteHost: string): PastedCookie[] {
  const domain = siteHost.toLowerCase().replace(/^www\./, '');
  const input = text.trim().replace(/^cookie:\s*/i, '');
  if (!input) throw new Error('Paste the cookie first.');
  const pairs = input.includes('=')
    ? input
        .split(';')
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
          const at = part.indexOf('=');
          return at < 0 ? null : [part.slice(0, at).trim(), part.slice(at + 1).trim()];
        })
    : [['cf_clearance', input]];
  const cookies: PastedCookie[] = [];
  for (const pair of pairs) {
    if (!pair || !COOKIE_NAME.test(pair[0]) || !COOKIE_VALUE.test(pair[1])) {
      throw new Error('That doesn’t look like a cookie. Copy it again from your browser.');
    }
    const [name, value] = pair;
    if (cookies.some((cookie) => cookie.name === name)) continue;
    cookies.push({
      name,
      value,
      domain,
      hostOnly: false,
      path: '/',
      secure: true,
      httpOnly: false,
    });
  }
  if (cookies.length > 300) throw new Error('That is more cookies than a site sets.');
  return cookies;
}

/** A header name followed by its value ("Accept-Language: en-US"). A User-Agent's own
 * colons ("rv:159.0") have no space after them. */
const NEXT_HEADER = /\s+[A-Za-z][A-Za-z0-9-]*:\s/;

/**
 * The pasted User-Agent: one line of printable text, as a browser sends it. Copying request
 * headers often brings the next ones along ("Accept-Language: …"), on the next line or
 * joined onto this one by a single-line box; only the User-Agent is kept, since Cloudflare
 * ties its clearance to that exact string.
 */
export function parsePastedUserAgent(text: string): string {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const line =
    lines.find((candidate) => /^user-agent:/i.test(candidate)) ??
    lines.find((candidate) => candidate) ??
    '';
  const userAgent = line
    .replace(/^user-agent:\s*/i, '')
    .split(NEXT_HEADER)[0]
    .trim();
  if (!userAgent) throw new Error('Paste your browser’s User-Agent too.');
  if (userAgent.length > 512 || !/^[\x20-\x7e]+$/.test(userAgent)) {
    throw new Error('That doesn’t look like a User-Agent. Copy it again from your browser.');
  }
  return userAgent;
}
