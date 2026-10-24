import { describe, it, expect, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { UpdateControls } from '@/components/settings/update-controls';

const toast = vi.fn();
vi.mock('@/hooks/use-toast', () => ({ toast: (...args: unknown[]) => toast(...args) }));

/**
 * These controls drive the desktop shell's self-update, but they live in `apps/web`, which has
 * to keep working in a plain browser with no Electron APIs present. Both halves of that are
 * worth pinning: nothing renders without the bridge, and nothing renders when the bridge says
 * this build has no update feed (a dev run) — in both cases an "update" button could only ever
 * fail if it were shown.
 */

interface FakeState {
  supported: boolean;
  status: string;
  currentVersion: string;
  availableVersion: string | null;
  downloadPercent: number | null;
  error: string | null;
  autoDownload: boolean;
}

function installBridge(state: Partial<FakeState>) {
  const full: FakeState = {
    supported: true,
    status: 'up-to-date',
    currentVersion: '1.0.0',
    availableVersion: null,
    downloadPercent: null,
    error: null,
    autoDownload: true,
    ...state,
  };
  const bridge = {
    getState: vi.fn(async () => ({ success: true, data: full })),
    check: vi.fn(async () => ({ success: true, data: full })),
    download: vi.fn(async () => ({ success: true, data: full })),
    setAutoDownload: vi.fn(async () => ({ success: true, data: full })),
    installNow: vi.fn(async () => ({ success: true, data: null })),
  };
  (window as unknown as { desktop?: unknown }).desktop = { update: bridge };
  return bridge;
}

afterEach(() => {
  delete (window as unknown as { desktop?: unknown }).desktop;
  toast.mockClear();
});

describe('UpdateControls', () => {
  it('renders nothing in a plain browser, where there is no desktop bridge', () => {
    const { container } = render(<UpdateControls />);

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the shell reports no update feed (a dev run)', async () => {
    installBridge({ supported: false, status: 'unsupported' });

    const { container } = render(<UpdateControls />);

    // Give the initial poll a chance to resolve — the point is that it stays empty after it does.
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('shows the current state and the auto-download toggle once supported', async () => {
    installBridge({ supported: true, status: 'up-to-date', autoDownload: true });

    render(<UpdateControls />);

    expect(await screen.findByText(/up to date/i)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /download updates automatically/i })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('offers a restart action only once an update has finished downloading', async () => {
    installBridge({ status: 'downloaded', availableVersion: '1.1.0' });

    render(<UpdateControls />);

    expect(await screen.findByRole('button', { name: /restart to install/i })).toBeInTheDocument();
    // "Download now" belongs to the not-yet-downloaded state; showing both would be incoherent.
    expect(screen.queryByRole('button', { name: /download now/i })).not.toBeInTheDocument();
  });

  it('reports a failed update check instead of leaving an unhandled action', async () => {
    const bridge = installBridge({ status: 'up-to-date' });
    bridge.check.mockRejectedValueOnce(new Error('Update server unavailable'));
    render(<UpdateControls />);
    fireEvent.click(await screen.findByRole('button', { name: /check for updates/i }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' })),
    );
  });
});
