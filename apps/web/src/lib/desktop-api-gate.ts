'use client';

import { desktopBridge } from '@/lib/desktop-bridge';

/**
 * Whether the desktop app's own API is up yet.
 *
 * The window opens as soon as the web server answers, but the API can take much longer —
 * above all on the first start after an update, when antivirus scans each of its newly
 * installed files as it is first read. Until it listens, every request would fail with a
 * 500. The API client awaits `waitForDesktopApi()` before each request instead (see
 * api-config.ts), and AppShell shows a "starting" screen meanwhile.
 *
 * Resolves straight away in a plain browser, in development, and on desktop builds that do
 * not report the API's status. A failed start resolves too, so requests go out and the app
 * shows its usual "can't reach the server" state rather than waiting forever.
 */

type ApiStatus = 'unmanaged' | 'starting' | 'ready' | 'failed';

interface InitBridge {
  getState: () => Promise<{
    success: boolean;
    data?: { apiStatus?: ApiStatus; apiStartedAt?: number | null };
  }>;
}

/** An API that is still loading takes seconds, so this needn't be fast. */
const POLL_MS = 400;

let gate: Promise<void> | null = null;
let starting = false;
let startedAt: number | null = null;
const listeners = new Set<() => void>();

function setStarting(next: boolean, since: number | null): void {
  if (starting === next && startedAt === since) return;
  starting = next;
  startedAt = since;
  for (const listener of listeners) listener();
}

export function waitForDesktopApi(): Promise<void> {
  if (gate) return gate;
  const bridge =
    typeof window === 'undefined' ? null : (desktopBridge<{ init: InitBridge }>()?.init ?? null);
  if (!bridge) {
    gate = Promise.resolve();
    return gate;
  }
  gate = (async () => {
    for (;;) {
      try {
        const { data } = await bridge.getState();
        if (data?.apiStatus !== 'starting') break;
        setStarting(true, data.apiStartedAt ?? null);
      } catch {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    setStarting(false, null);
  })();
  return gate;
}

export function getDesktopApiStarting(): { starting: boolean; startedAt: number | null } {
  return { starting, startedAt };
}

export function subscribeDesktopApiStarting(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
