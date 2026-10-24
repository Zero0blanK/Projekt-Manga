// MangaDex publishes a global ~5 requests/s/IP and an AtHome limit of 40/minute.
// Keep headroom and share dispatch times across every sandbox in this parent process.
// https://gitlab.com/mangadex-pub/mangadex-api-docs/-/raw/main/2-limitations.md
const API_SPACING_MS = 250;
const AT_HOME_SPACING_MS = 1600;
const dispatchTimes = new Map([
  ['api.mangadex.org', { api: 0, atHome: 0 }],
  ['api.mangadex.dev', { api: 0, atHome: 0 }],
]);

function wait(delay: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delay);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function waitForMangaDexDispatch(
  url: URL,
  method: string,
  signal: AbortSignal,
): Promise<void> {
  const times = dispatchTimes.get(url.hostname);
  if (!times) return;
  const atHome =
    method.toUpperCase() === 'GET' && /^\/at-home\/server\/[^/]+\/?$/.test(url.pathname);
  for (;;) {
    signal.throwIfAborted();
    const now = performance.now();
    const delay = Math.max(times.api, atHome ? times.atHome : 0) - now;
    if (delay <= 0) {
      // No await between checking and claiming: competing sandboxes cannot claim together.
      times.api = now + API_SPACING_MS;
      if (atHome) times.atHome = now + AT_HOME_SPACING_MS;
      return;
    }
    await wait(delay, signal);
  }
}
