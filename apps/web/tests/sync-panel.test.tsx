import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runDesktopSync, getState, syncState, settings } = vi.hoisted(() => ({
  runDesktopSync: vi.fn(),
  getState: vi.fn(),
  syncState: { running: false, lastSuccess: null, error: null },
  settings: { desktopSyncEnabled: true as boolean },
}));

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
  useSetting: (key: string, fallback: unknown) =>
    settings[key as keyof typeof settings] ?? fallback,
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
}));
vi.mock('@/components/settings/download-folder-field', () => ({ DownloadFolderField: () => null }));
vi.mock('@/components/downloads/open-folder-button', () => ({ OpenFolderButton: () => null }));

import { SyncPanel } from '@/components/settings/sync-panel';

beforeEach(() => {
  vi.clearAllMocks();
  syncState.running = false;
  syncState.lastSuccess = null;
  syncState.error = null;
  settings.desktopSyncEnabled = true;
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

    expect(screen.getByText(/Offline\. Local reading and downloads remain available/)).toBeTruthy();
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
    expect(
      await screen.findByText(
        'Sync is paused for this device; local reading and downloads remain available',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sync paused' })).toBeDisabled();
  });
});
