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

vi.mock('@projekt-manga/api-client', () => ({
  ApiError: FakeApiError,
  getManga: vi.fn().mockResolvedValue([]),
  getLibraryState: vi.fn().mockResolvedValue([]),
  updateLibraryState: vi.fn(),
  getSources: vi.fn().mockResolvedValue([]),
  getSourceManga: vi.fn().mockResolvedValue([]),
  getSourceFilters: vi.fn().mockResolvedValue([]),
  buildImageProxyUrl: (u: string) => u,
}));

const { reportSourceFailure } = await import('@/lib/library-store');

let testClock = Date.UTC(2026, 0, 1);

beforeEach(() => {
  vi.clearAllMocks();
  // The dedupe window is real time, so move the clock rather than waiting it out.
  vi.useFakeTimers();
  // A fresh minute per test: the dedupe map is module state that outlives any one test,
  // so a frozen clock would let one test's entry suppress the next test's toast.
  testClock += 60_000;
  vi.setSystemTime(new Date(testClock));
});

/**
 * A failing source must not be silent: if the call were caught and turned into an empty
 * list, an outage and "this source has nothing" would look identical and the browse page
 * would blame the reader's filters. These pin the failure reporting.
 */
describe('reportSourceFailure', () => {
  it('tells the reader which source failed and why', () => {
    reportSourceFailure(new FakeApiError('Upstream returned 503', 503, 'http'), 'mangadex');

    expect(toast).toHaveBeenCalledTimes(1);
    const arg = toast.mock.calls[0][0];
    expect(arg.variant).toBe('destructive');
    expect(arg.description).toContain('mangadex');
    expect(arg.description).toContain('Upstream returned 503');
  });

  it('reports a timeout in its own words, not as a generic failure', () => {
    reportSourceFailure(
      new FakeApiError(
        'This took too long to respond. The source may be slow or unreachable — try again.',
        0,
        'timeout',
      ),
      'kissmanga',
    );

    expect(toast.mock.calls[0][0].description).toContain('took too long');
  });

  it('stays silent for a cancelled request', () => {
    // Navigating away or changing filters aborts the in-flight request every time; that
    // is the app working, not something to interrupt the reader about.
    reportSourceFailure(new FakeApiError('Request cancelled', 0, 'aborted'), 'mangadex');

    expect(toast).not.toHaveBeenCalled();
  });

  it('falls back to a readable message for a non-ApiError', () => {
    reportSourceFailure(new TypeError('undefined is not a function'), 'mangatx');

    expect(toast.mock.calls[0][0].description).toContain('mangatx');
    expect(toast.mock.calls[0][0].description).toContain('Something went wrong');
  });

  it('collapses a burst of identical failures into one toast', () => {
    // A multi-source browse reports each source separately; three failures of the same
    // source in one action must not stack three toasts.
    for (let i = 0; i < 3; i++) {
      reportSourceFailure(new FakeApiError('Upstream returned 503', 503, 'http'), 'mangadex');
    }

    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('still reports each distinct source in the same burst', () => {
    reportSourceFailure(new FakeApiError('down', 503, 'http'), 'mangadex');
    reportSourceFailure(new FakeApiError('down', 503, 'http'), 'kissmanga');

    expect(toast).toHaveBeenCalledTimes(2);
  });

  it('reports again once the dedupe window has passed, so a real retry is not swallowed', () => {
    reportSourceFailure(new FakeApiError('down', 503, 'http'), 'mangadex');
    vi.setSystemTime(new Date(testClock + 30_000));
    reportSourceFailure(new FakeApiError('down', 503, 'http'), 'mangadex');

    expect(toast).toHaveBeenCalledTimes(2);
  });
});
