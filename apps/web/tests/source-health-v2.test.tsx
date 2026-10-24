import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  getScraperHealth: vi.fn(),
  getSourceHealth: vi.fn(),
  listInstalledExtensions: vi.fn(),
}));
vi.mock('@projekt-manga/api-client', () => mocks);
import { SourceHealthPanel } from '@/components/settings/source-health-panel';
import { SourceHealthSummary } from '@/components/discover/source-health-summary';

function extension(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ext',
    source_key: 'source',
    name: 'Fixture source',
    version: '1.0.0',
    api_version: 1,
    enabled: true,
    ...overrides,
  };
}

/** A fresh client per test: a shared cache would leak one test's fixtures into the next. */
function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <SourceHealthPanel />
    </QueryClientProvider>,
  );
}

/** The detail lives behind a dialog, so opening it is part of reaching the evidence. */
async function openDialog() {
  await userEvent.click(await screen.findByRole('button', { name: 'View source health' }));
  return screen.findByRole('dialog', { name: 'Source health' });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listInstalledExtensions.mockResolvedValue([extension()]);
  mocks.getSourceHealth.mockResolvedValue([]);
  mocks.getScraperHealth.mockResolvedValue({ available: true, circuitBreakers: [] });
});

describe('Honest source health evidence', () => {
  it('distinguishes an unavailable observation endpoint from no observations', async () => {
    mocks.getSourceHealth.mockRejectedValue(new Error('offline'));
    mocks.getScraperHealth.mockRejectedValue(new Error('not supported'));
    renderPanel();
    await openDialog();
    // The verdict says what is known; the rows say why, so the phrase is not repeated per row.
    expect(await screen.findByText('Status unknown')).toBeInTheDocument();
    expect(screen.getAllByText('Server did not report')).toHaveLength(2);
    expect(screen.getByText('Not available in this build')).toBeInTheDocument();
    expect(screen.queryByText(/No requests yet/)).toBeNull();
  });

  it('shows no observations without inventing a successful browse', async () => {
    renderPanel();
    await openDialog();
    expect((await screen.findAllByText('No requests yet')).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Succeeded/)).toBeNull();
  });

  it('shows recorded errors and cooldowns without declaring a source successful', () => {
    render(
      <SourceHealthSummary
        sourceId="source"
        apiVersion={999}
        snapshot={{
          unavailable: false,
          breakers: [],
          health: [
            {
              sourceId: 'source',
              browse: {
                lastSuccessAt: null,
                lastErrorCode: 'RATE_LIMITED',
                retryAfterAt: new Date(Date.now() + 60_000).toISOString(),
              },
            },
          ] as never,
        }}
      />,
    );
    expect(screen.getByRole('link')).toHaveTextContent('API v999 unsupported');
    expect(screen.getByRole('link')).toHaveTextContent('Not checked since server start');
    expect(screen.getByRole('link')).toHaveTextContent('Latest failure: RATE_LIMITED');
    expect(screen.getByRole('link')).toHaveTextContent('Cooldown until');
  });
});

describe('Source health is reference material, not a wall of rows', () => {
  it('keeps the detail out of the page until it is asked for', async () => {
    renderPanel();

    // The panel reports a count, but the two per-source observation endpoints are not
    // requested at all — that deferral is the point of the dialog.
    expect(await screen.findByText('1 installed · nothing reporting problems')).toBeInTheDocument();
    expect(mocks.getScraperHealth).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();

    await openDialog();
    expect(mocks.getScraperHealth).toHaveBeenCalled();
  });

  it('surfaces a source that needs attention in the collapsed row', async () => {
    // Hiding a broken source behind a click nobody has a reason to make would be worse
    // than scrolling past it.
    mocks.listInstalledExtensions.mockResolvedValue([extension({ api_version: 999 })]);
    renderPanel();

    expect(await screen.findByText('1 of 1 need attention')).toBeInTheDocument();
  });

  it('gives each source a verdict and sorts the broken ones first', async () => {
    mocks.listInstalledExtensions.mockResolvedValue([
      extension({ id: 'healthy', source_key: 'healthy', name: 'Zulu healthy' }),
      extension({ id: 'broken', source_key: 'broken', name: 'Alpha broken', api_version: 999 }),
    ]);
    mocks.getSourceHealth.mockResolvedValue([
      {
        sourceId: 'healthy',
        browse: {
          lastAttemptAt: new Date(Date.now() - 60_000).toISOString(),
          lastSuccessAt: new Date(Date.now() - 60_000).toISOString(),
          lastErrorCode: null,
          retryAfterAt: null,
        },
      },
    ]);
    renderPanel();
    const dialog = await openDialog();

    expect(await screen.findByText('1 of 2 sources need attention')).toBeInTheDocument();

    // Order, not just presence: the row worth reading has to be the first one.
    const verdicts = Array.from(dialog.querySelectorAll('li')).map((row) => row.textContent ?? '');
    expect(verdicts[0]).toContain('Alpha broken');
    expect(verdicts[0]).toContain('Needs an update');
    expect(verdicts[1]).toContain('Zulu healthy');
    expect(verdicts[1]).toContain('Working');
  });

  it('does not call a source "working" before it has ever succeeded', async () => {
    // A fresh install has sources nobody has browsed yet. Counting those as working is the
    // same invention the per-row copy is careful to avoid.
    renderPanel();
    await openDialog();

    expect(await screen.findByText('1 sources · nothing reporting problems')).toBeInTheDocument();
    expect(screen.queryByText(/sources are working/)).toBeNull();
    expect(screen.getByText('Not used yet')).toBeInTheDocument();
  });

  it('says "working" once every source has a recorded success', async () => {
    mocks.getSourceHealth.mockResolvedValue([
      {
        sourceId: 'source',
        browse: {
          lastAttemptAt: new Date(Date.now() - 60_000).toISOString(),
          lastSuccessAt: new Date(Date.now() - 60_000).toISOString(),
          lastErrorCode: null,
          retryAfterAt: null,
        },
      },
    ]);
    renderPanel();
    await openDialog();

    expect(await screen.findByText('All 1 sources are working')).toBeInTheDocument();
  });

  it('reports a relative time for a success rather than a raw timestamp', async () => {
    mocks.getSourceHealth.mockResolvedValue([
      {
        sourceId: 'source',
        browse: {
          lastAttemptAt: new Date(Date.now() - 4 * 60_000).toISOString(),
          lastSuccessAt: new Date(Date.now() - 4 * 60_000).toISOString(),
          lastErrorCode: null,
          retryAfterAt: null,
        },
      },
    ]);
    renderPanel();
    await openDialog();

    expect(await screen.findByText('Succeeded 4 minutes ago')).toBeInTheDocument();
  });

  it('returns focus to the trigger when the dialog closes', async () => {
    renderPanel();
    const trigger = await screen.findByRole('button', { name: 'View source health' });
    await openDialog();

    await userEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(await screen.findByRole('button', { name: 'View source health' })).toHaveFocus();
    expect(trigger).toHaveFocus();
  });
});
