import { afterEach, describe, expect, it, vi } from 'vitest';
import { getServerManga } from '@projekt-manga/api-client';
import { FIRST_LIBRARY_PAGE, libraryPreloadScript, scriptString } from '@/lib/library-preload';

afterEach(() => {
  vi.unstubAllGlobals();
  document.head.innerHTML = '';
  delete (window as { desktop?: unknown }).desktop;
});

function runScript() {
  new Function(libraryPreloadScript())();
  return document.head.querySelector<HTMLLinkElement>('link[rel="preload"]');
}

describe('preloading the library', () => {
  it('preloads exactly the request the app makes first, so the browser can reuse it', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ success: true, data: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await getServerManga({}, undefined, { firstPageSize: FIRST_LIBRARY_PAGE });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];

    const link = runScript();
    expect(link?.href).toBe(new URL(url, window.location.href).href);
    expect(link?.as).toBe('fetch');
    // Credentials have to match too: the app sends the session cookie.
    expect(init.credentials).toBe('include');
    expect(link?.crossOrigin).toBe('use-credentials');
  });

  it('does nothing in the desktop app, which reads its own database', () => {
    (window as { desktop?: unknown }).desktop = {};
    expect(runScript()).toBeNull();
  });

  it('writes a URL into the inline script so it can never end the element', () => {
    const hostile = 'https://x.test/api/</script><script>alert(1)</script><!--';
    const literal = scriptString(hostile);
    expect(literal).not.toMatch(/[<>]/);
    // It reads back as exactly the same string.
    expect(new Function(`return ${literal}`)()).toBe(hostile);
  });
});
