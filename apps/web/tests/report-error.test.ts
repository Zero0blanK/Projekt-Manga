import { describe, it, expect, vi, beforeEach } from 'vitest';

const toast = vi.fn();
vi.mock('@/hooks/use-toast', () => ({ toast: (...a: unknown[]) => toast(...a) }));

class FakeApiError extends Error {
  status: number;
  kind: string;
  constructor(message: string, status: number, kind: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.kind = kind;
  }
}

vi.mock('@projekt-manga/api-client', () => ({ ApiError: FakeApiError }));

const { reportError, isAborted } = await import('@/lib/report-error');

let clock = Date.UTC(2026, 0, 1);

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  // The dedupe map is module state that outlives a single test, so each test needs its
  // own point on the clock rather than a frozen one.
  clock += 60_000;
  vi.setSystemTime(new Date(clock));
});

describe('reportError', () => {
  it('says what failed in the app’s words, plus the detail the client knows', () => {
    reportError(new FakeApiError('The server is unreachable.', 0, 'network'), "Couldn't load X.");

    expect(toast).toHaveBeenCalledTimes(1);
    const arg = toast.mock.calls[0][0];
    expect(arg.variant).toBe('destructive');
    expect(arg.description).toContain("Couldn't load X.");
    expect(arg.description).toContain('The server is unreachable.');
  });

  it('stays silent for a cancelled request', () => {
    // Navigating away or changing a filter aborts in-flight requests constantly; those
    // are the app working, and toasting them would bury the real failures.
    reportError(new FakeApiError('Request cancelled', 0, 'aborted'), "Couldn't load X.");

    expect(toast).not.toHaveBeenCalled();
  });

  it('still reports something useful when the error is not an ApiError', () => {
    reportError(new TypeError('x is not a function'), "Couldn't load X.");

    // The raw message is not shown — it means nothing to a reader.
    expect(toast.mock.calls[0][0].description).toBe("Couldn't load X.");
  });

  it('collapses repeats of the same message into one toast', () => {
    for (let i = 0; i < 4; i++) {
      reportError(new FakeApiError('down', 503, 'http'), "Couldn't load X.");
    }

    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('reports distinct failures separately in the same burst', () => {
    reportError(new FakeApiError('down', 503, 'http'), "Couldn't load X.");
    reportError(new FakeApiError('down', 503, 'http'), "Couldn't load Y.");

    expect(toast).toHaveBeenCalledTimes(2);
  });

  it('reports again once the window has passed, so a deliberate retry is answered', () => {
    reportError(new FakeApiError('down', 503, 'http'), "Couldn't load X.");
    vi.setSystemTime(new Date(clock + 30_000));
    reportError(new FakeApiError('down', 503, 'http'), "Couldn't load X.");

    expect(toast).toHaveBeenCalledTimes(2);
  });
});

describe('isAborted', () => {
  it('recognises only a cancelled request', () => {
    expect(isAborted(new FakeApiError('Request cancelled', 0, 'aborted'))).toBe(true);
    expect(isAborted(new FakeApiError('timed out', 0, 'timeout'))).toBe(false);
    expect(isAborted(new Error('boom'))).toBe(false);
    expect(isAborted(null)).toBe(false);
  });
});
