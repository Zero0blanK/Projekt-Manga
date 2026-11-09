import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  listeners: [] as Array<(failure: { path: string; code?: string }) => void>,
  setting: true as boolean,
  health: [] as unknown[],
}));

vi.mock('@projekt-manga/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@projekt-manga/api-client')>()),
  onRequestFailure: (listener: (failure: { path: string; code?: string }) => void) => {
    mocks.listeners.push(listener);
    return () => mocks.listeners.splice(mocks.listeners.indexOf(listener), 1);
  },
  getSourceHealth: vi.fn(async () => mocks.health),
}));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));
vi.mock('@/lib/app-store', () => ({ getSetting: () => mocks.setting }));
vi.mock('@/lib/library-store', () => ({ useSources: () => ({ sources: [] }) }));

const { SourceChallengeAutoOpen } = await import('@/components/source-challenge-auto-open');
const { SourceChallengeNotice } = await import('@/components/discover/source-challenge-notice');
const { sourceIdFromPath } = await import('@/lib/source-browser');
const { resetSourceChecks, getSourceCheck } = await import('@/lib/source-check');

const openBrowser = vi.fn();
const fail = (path: string, code = 'CHALLENGE_REQUIRED') =>
  mocks.listeners.forEach((listener) => listener({ path, code }));
const passed = {
  success: true,
  message: 'ok',
  data: { saved: true, passed: true, cookieCount: 2, message: 'Passed.' },
};
const notPassed = {
  success: true,
  message: 'ok',
  data: { saved: true, passed: false, cookieCount: 1, message: 'Saved.' },
};

let now = 1_000_000;

beforeEach(() => {
  resetSourceChecks();
  mocks.listeners.length = 0;
  mocks.setting = true;
  mocks.health = [];
  now = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  openBrowser.mockReset().mockResolvedValue(passed);
  Object.defineProperty(window, 'desktop', {
    configurable: true,
    value: { source: { openBrowser } },
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, 'desktop');
});

describe('passing a source check in the background', () => {
  it('starts one hidden check for a source, however many requests it stopped', async () => {
    render(<SourceChallengeAutoOpen />);
    fail('/source/manhuaus/catalogue');
    fail('/source/manhuaus/manga/x');
    fail('/source/other/catalogue', 'NETWORK_ERROR');
    await waitFor(() => expect(getSourceCheck('manhuaus').status).toBe('passed'));
    expect(openBrowser).toHaveBeenCalledTimes(1);
    expect(openBrowser).toHaveBeenCalledWith('manhuaus', { closeWhenPassed: true });
  });

  it('checks again when the clearance runs out later, not just once per run', async () => {
    render(<SourceChallengeAutoOpen />);
    fail('/source/manhuaus/catalogue');
    await waitFor(() => expect(getSourceCheck('manhuaus').status).toBe('passed'));

    now += 2 * 60 * 60_000;
    fail('/source/manhuaus/catalogue');
    await waitFor(() => expect(openBrowser).toHaveBeenCalledTimes(2));
  });

  it('stops instead of looping when a pass did not get the app through', async () => {
    render(<SourceChallengeAutoOpen />);
    fail('/source/manhuaus/catalogue');
    await waitFor(() => expect(getSourceCheck('manhuaus').status).toBe('passed'));

    now += 5_000;
    fail('/source/manhuaus/catalogue');
    expect(openBrowser).toHaveBeenCalledTimes(1);
    expect(getSourceCheck('manhuaus')).toMatchObject({ status: 'failed' });
  });

  it('waits after a failed check before trying by itself again', async () => {
    openBrowser.mockResolvedValue(notPassed);
    render(<SourceChallengeAutoOpen />);
    fail('/source/manhuaus/catalogue');
    await waitFor(() => expect(getSourceCheck('manhuaus').status).toBe('failed'));

    now += 60_000;
    fail('/source/manhuaus/catalogue');
    expect(openBrowser).toHaveBeenCalledTimes(1);
    now += 11 * 60_000;
    fail('/source/manhuaus/catalogue');
    await waitFor(() => expect(openBrowser).toHaveBeenCalledTimes(2));
  });

  it('also checks a source that met a check during a library update', async () => {
    mocks.health = [
      {
        sourceId: 'quiet-source',
        browse: null,
        update: {
          lastAttemptAt: new Date(now - 1000).toISOString(),
          lastSuccessAt: null,
          lastErrorCode: 'CHALLENGE_REQUIRED',
          retryAfterAt: null,
        },
      },
      {
        sourceId: 'fine-source',
        browse: {
          lastAttemptAt: new Date(now).toISOString(),
          lastSuccessAt: null,
          lastErrorCode: null,
          retryAfterAt: null,
        },
        update: null,
      },
    ];
    render(<SourceChallengeAutoOpen />);
    await waitFor(() =>
      expect(openBrowser).toHaveBeenCalledWith('quiet-source', { closeWhenPassed: true }),
    );
    expect(openBrowser).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the setting is off, or outside the desktop app', async () => {
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

describe('the notice where a source asked for a check', () => {
  it('passes the check by itself and retries what failed, with nothing to press', async () => {
    let finish!: (value: unknown) => void;
    openBrowser.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const onPassed = vi.fn();
    render(<SourceChallengeNotice sourceId="manhuaus" sourceName="Manhuaus" onPassed={onPassed} />);

    expect(
      await screen.findByText(/Passing Manhuaus's browser check in the background/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
    await act(async () => finish(passed));

    expect(onPassed).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Passed Manhuaus's browser check.")).toBeInTheDocument();
  });

  it('offers to try again when the check failed', async () => {
    openBrowser.mockResolvedValueOnce(notPassed).mockResolvedValueOnce(passed);
    render(<SourceChallengeNotice sourceId="manhuaus" sourceName="Manhuaus" />);
    const retry = await screen.findByRole('button', { name: 'Try again' });
    expect(screen.getByText('The window closed before the check was passed.')).toBeInTheDocument();

    await act(async () => fireEvent.click(retry));
    expect(openBrowser).toHaveBeenCalledTimes(2);
  });
});
