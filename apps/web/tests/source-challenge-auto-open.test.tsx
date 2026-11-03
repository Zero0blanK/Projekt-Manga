import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  listeners: [] as Array<(failure: { path: string; code?: string }) => void>,
  setting: true as boolean,
}));

vi.mock('@projekt-manga/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@projekt-manga/api-client')>()),
  onRequestFailure: (listener: (failure: { path: string; code?: string }) => void) => {
    mocks.listeners.push(listener);
    return () => mocks.listeners.splice(mocks.listeners.indexOf(listener), 1);
  },
}));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));
vi.mock('@/lib/app-store', () => ({ getSetting: () => mocks.setting }));

const { SourceChallengeAutoOpen } = await import('@/components/source-challenge-auto-open');
const { sourceIdFromPath } = await import('@/lib/source-browser');

const openBrowser = vi.fn();
const fail = (path: string, code = 'CHALLENGE_REQUIRED') =>
  mocks.listeners.forEach((listener) => listener({ path, code }));

describe('opening a source check window by itself', () => {
  beforeEach(() => {
    mocks.listeners.length = 0;
    mocks.setting = true;
    openBrowser.mockReset().mockResolvedValue({
      success: true,
      message: 'Saved',
      data: { saved: true, cookieCount: 2, message: 'Session saved.' },
    });
    Object.defineProperty(window, 'desktop', {
      configurable: true,
      value: { source: { openBrowser } },
    });
  });
  afterEach(() => Reflect.deleteProperty(window, 'desktop'));

  it('opens the source the check stopped, once per run', async () => {
    render(<SourceChallengeAutoOpen />);
    fail('/source/manhuaus/catalogue');
    fail('/source/manhuaus/manga/x');
    fail('/source/other/catalogue', 'NETWORK_ERROR');
    await waitFor(() => expect(openBrowser).toHaveBeenCalledTimes(1));
    expect(openBrowser).toHaveBeenCalledWith('manhuaus', { closeWhenPassed: true });
  });

  it('stays closed when the setting is off, or outside the desktop app', async () => {
    mocks.setting = false;
    const { unmount } = render(<SourceChallengeAutoOpen />);
    fail('/source/toonily/catalogue');
    unmount();
    Reflect.deleteProperty(window, 'desktop');
    render(<SourceChallengeAutoOpen />);
    expect(mocks.listeners).toHaveLength(0);
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it('reads the source from a request path', () => {
    expect(sourceIdFromPath('/source/manhuaus/catalogue')).toBe('manhuaus');
    expect(sourceIdFromPath('/source/suwayomi-12/manga/3')).toBe('suwayomi-12');
    expect(sourceIdFromPath('/source/image-proxy/x')).toBeNull();
    expect(sourceIdFromPath('/manga/1')).toBeNull();
  });
});
