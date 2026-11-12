import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@projekt-manga/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@projekt-manga/api-client')>()),
  getSourceBrowserSession: (...args: unknown[]) => api.get(...args),
}));
vi.mock('@/lib/library-store', () => ({
  useSources: () => ({
    sources: [{ id: 'manhuaus', base_url: 'https://manhuaus.com/' }],
  }),
}));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));
// Automatic checks off, so the notice shows its prompt instead of starting one.
vi.mock('@/lib/app-store', () => ({ getSetting: () => false }));

const { SourceChallengeNotice } = await import('@/components/discover/source-challenge-notice');

function renderNotice() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SourceChallengeNotice sourceId="manhuaus" sourceName="ManhuaUS" />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.clearAllMocks();
  Reflect.deleteProperty(window, 'desktop');
});

describe('SourceChallengeNotice', () => {
  it('says a saved session may be stale when the check comes back', async () => {
    Object.defineProperty(window, 'desktop', {
      configurable: true,
      value: { source: { openBrowser: vi.fn() } },
    });
    api.get.mockResolvedValue({
      sourceId: 'manhuaus',
      hosts: ['manhuaus.com'],
      updatedAt: new Date().toISOString(),
      userAgent: 'Mozilla/5.0 Test',
      cookies: [{ name: 'cf_clearance', domain: 'manhuaus.com', expires: null }],
    });

    renderNotice();

    expect(await screen.findByText(/A session is already saved/)).toBeInTheDocument();
    expect(screen.getByText(/different network than the browser/)).toBeInTheDocument();
  });

  it('shows the plain check copy when no session is saved', async () => {
    Object.defineProperty(window, 'desktop', {
      configurable: true,
      value: { source: { openBrowser: vi.fn() } },
    });
    api.get.mockResolvedValue({
      sourceId: 'manhuaus',
      hosts: [],
      updatedAt: null,
      userAgent: null,
      cookies: [],
    });

    renderNotice();

    expect(await screen.findByText(/wants a browser check/i)).toBeInTheDocument();
    await vi.waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(screen.queryByText(/A session is already saved/)).not.toBeInTheDocument();
  });
});
