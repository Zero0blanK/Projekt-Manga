import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runDesktopSync, getState, syncState, settings, customCategories, setSetting } = vi.hoisted(
  () => ({
    runDesktopSync: vi.fn(),
    getState: vi.fn(),
    syncState: { running: false, lastSuccess: null, error: null },
    settings: { desktopSyncEnabled: true as boolean } as Record<string, unknown>,
    customCategories: [] as string[],
    setSetting: vi.fn(),
  }),
);

vi.mock('@projekt-manga/api-client', () => ({
  getDownloadStats: vi.fn(async () => null),
  getDownloadDirectory: vi.fn(async () => ({ path: null })),
  hasLocalDataBridge: () => true,
}));
vi.mock('@/lib/session-resource', () => ({ useCurrentUser: () => ({ user: { id: 'reader-1' } }) }));
vi.mock('@/lib/desktop-sync', () => ({
  runDesktopSync,
  useDesktopSyncState: () => syncState,
}));
vi.mock('@/lib/restore-job', () => ({ useRestorePending: () => false }));
vi.mock('@/lib/report-error', () => ({ isAborted: () => false, reportError: vi.fn() }));
vi.mock('@/lib/app-store', () => ({
  useSetting: (key: string, fallback: unknown) => settings[key] ?? fallback,
  useAppState: (
    select: (state: {
      categoryMembers: Record<string, string[]>;
      customCategories: string[];
    }) => unknown,
  ) => select({ categoryMembers: {}, customCategories }),
  actions: { setSetting },
}));
vi.mock('@/components/settings/field-controls', () => ({
  Panel: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <section aria-label={title}>{children}</section>
  ),
  Field: ({
    label,
    hint,
    children,
  }: {
    label: string;
    hint?: string;
    children: React.ReactNode;
  }) => (
    <div>
      <span>{label}</span>
      {hint && <span>{hint}</span>}
      {children}
    </div>
  ),
  Group: () => null,
  Toggle: () => null,
  Select: () => null,
  OptionSelect: () => null,
  NumberSelect: () => null,
}));
vi.mock('@/components/settings/download-folder-field', () => ({ DownloadFolderField: () => null }));
vi.mock('@/components/downloads/open-folder-button', () => ({ OpenFolderButton: () => null }));
vi.mock('@/components/settings/trackers-panel', () => ({ TrackersPanel: () => null }));

import { SyncPanel } from '@/components/settings/sync-panel';

beforeEach(() => {
  vi.clearAllMocks();
  syncState.running = false;
  syncState.lastSuccess = null;
  syncState.error = null;
  for (const key of Object.keys(settings)) delete settings[key];
  settings.desktopSyncEnabled = true;
  customCategories.length = 0;
  getState.mockResolvedValue({
    success: true,
    data: { seedStatus: 'running', hadLocalData: true, seededManga: 0 },
  });
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  Object.defineProperty(window, 'desktop', {
    configurable: true,
    value: { init: { getState } },
  });
});

describe('SyncPanel desktop state', () => {
  it('shows the local library while it refreshes and explains offline availability', async () => {
    render(<SyncPanel />);

    expect(await screen.findByText('Available offline · refreshing in background')).toBeTruthy();
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    fireEvent(window, new Event('offline'));

    expect(screen.getByText('Offline; reading and downloads still work')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Offline' })).toBeDisabled();
  });

  it('offers a retry when the server sync failed while online', async () => {
    syncState.error = 'connection refused';
    render(<SyncPanel />);

    expect(await screen.findByText('Server sync failed: connection refused')).toBeTruthy();
    const retry = screen.getByRole('button', { name: 'Retry sync' });
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    await waitFor(() => expect(runDesktopSync).toHaveBeenCalledOnce());
  });

  it('explains when account sync is paused and disables manual sync', async () => {
    settings.desktopSyncEnabled = false;
    render(<SyncPanel />);
    expect(await screen.findByText('Paused on this device')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sync paused' })).toBeDisabled();
  });

  it('shows per-category intervals and stores muted categories as a JSON list', async () => {
    customCategories.push('Daily', 'Quiet');
    settings.updateCategoryIntervalHours = JSON.stringify({ Daily: 3 });
    settings.updateMutedCategories = JSON.stringify(['Daily']);
    render(<SyncPanel show="library" />);

    expect(await screen.findByRole('button', { name: 'Daily check interval' })).toHaveTextContent(
      '3 hours',
    );
    expect(screen.getByRole('button', { name: 'Quiet check interval' })).toHaveTextContent(
      'Global interval',
    );
    const muteField = screen.getByText('Mute new-chapter alerts').parentElement!;
    const quiet = within(muteField).getByRole('button', { name: 'Quiet' });
    expect(quiet).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(quiet);
    expect(setSetting).toHaveBeenCalledWith('updateMutedCategories', '["Daily","Quiet"]');
  });
});
