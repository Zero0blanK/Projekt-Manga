import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureApiClient, request, ApiError } from '@projekt-manga/api-client';

const ok = () => new Response(JSON.stringify({ success: true, data: 'pong' }));

afterEach(() => {
  configureApiClient({ baseUrl: 'http://localhost:4000/api' });
  vi.unstubAllGlobals();
  vi.resetModules();
  delete (window as { desktop?: unknown }).desktop;
});

describe('API client ready gate', () => {
  it('holds a request until the gate opens, then sends it', async () => {
    const fetchMock = vi.fn(async () => ok());
    vi.stubGlobal('fetch', fetchMock);
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => (open = resolve));
    configureApiClient({ baseUrl: 'http://localhost:4000/api', waitUntilReady: () => gate });

    const pending = request<string>('/ping');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).not.toHaveBeenCalled();

    open();
    await expect(pending).resolves.toBe('pong');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('lets a caller cancel while waiting', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok()),
    );
    configureApiClient({
      baseUrl: 'http://localhost:4000/api',
      waitUntilReady: () => new Promise<void>(() => {}),
    });
    const controller = new AbortController();
    const pending = request('/ping', { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: 'aborted' });
    await expect(pending).rejects.toBeInstanceOf(ApiError);
  });

  it('sends requests anyway when the gate rejects', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok()),
    );
    configureApiClient({
      baseUrl: 'http://localhost:4000/api',
      waitUntilReady: () => Promise.reject(new Error('bridge gone')),
    });
    await expect(request<string>('/ping')).resolves.toBe('pong');
  });
});

describe('waitForDesktopApi', () => {
  it('resolves at once in a plain browser', async () => {
    const { waitForDesktopApi, getDesktopApiStarting } = await import('@/lib/desktop-api-gate');
    await waitForDesktopApi();
    expect(getDesktopApiStarting().starting).toBe(false);
  });

  it('reports "starting" until the desktop app says the API is up', async () => {
    const states = [
      { apiStatus: 'starting', apiStartedAt: 1000 },
      { apiStatus: 'starting', apiStartedAt: 1000 },
      { apiStatus: 'ready', apiStartedAt: 1000 },
    ];
    const getState = vi.fn(async () => ({ success: true, data: states.shift() }));
    Object.defineProperty(window, 'desktop', {
      configurable: true,
      value: { init: { getState } },
    });
    const { waitForDesktopApi, getDesktopApiStarting, subscribeDesktopApiStarting } =
      await import('@/lib/desktop-api-gate');
    const seen: boolean[] = [];
    subscribeDesktopApiStarting(() => seen.push(getDesktopApiStarting().starting));

    await waitForDesktopApi();
    expect(getState).toHaveBeenCalledTimes(3);
    expect(seen).toEqual([true, false]);
    expect(getDesktopApiStarting()).toEqual({ starting: false, startedAt: null });
  });

  it('does not wait on desktop builds that do not report the API status', async () => {
    const getState = vi.fn(async () => ({ success: true, data: { seedStatus: 'running' } }));
    Object.defineProperty(window, 'desktop', {
      configurable: true,
      value: { init: { getState } },
    });
    const { waitForDesktopApi } = await import('@/lib/desktop-api-gate');
    await waitForDesktopApi();
    expect(getState).toHaveBeenCalledOnce();
  });
});
