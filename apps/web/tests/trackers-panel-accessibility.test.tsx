import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const {
  getAvailableTrackers,
  getConnectedTrackers,
  connectTrackerWithCredentials,
  disconnectTracker,
  getTrackerAuthorizeUrl,
  syncTrackersNow,
} = vi.hoisted(() => ({
  getAvailableTrackers: vi.fn(),
  getConnectedTrackers: vi.fn(),
  connectTrackerWithCredentials: vi.fn(),
  disconnectTracker: vi.fn(),
  getTrackerAuthorizeUrl: vi.fn(),
  syncTrackersNow: vi.fn(),
}));

vi.mock('@projekt-manga/api-client', () => ({
  getAvailableTrackers,
  getConnectedTrackers,
  connectTrackerWithCredentials,
  disconnectTracker,
  getTrackerAuthorizeUrl,
  syncTrackersNow,
  ApiError: class ApiError extends Error {},
}));
vi.mock('@/components/settings/field-controls', () => ({
  Field: ({
    label,
    hint,
    children,
  }: {
    label: string;
    hint: string;
    children: React.ReactNode;
  }) => (
    <div>
      <span>{label}</span>
      <span>{hint}</span>
      {children}
    </div>
  ),
}));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));

const { TrackersPanel } = await import('@/components/settings/trackers-panel');

describe('TrackersPanel accessibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAvailableTrackers.mockResolvedValue([
      { tracker: 'ANILIST', label: 'AniList', auth_kind: 'oauth', available: true },
    ]);
    getConnectedTrackers.mockResolvedValue([
      { tracker: 'ANILIST', tracker_username: 'fixture-reader' },
    ]);
  });

  it('returns focus to Disconnect when disconnect confirmation is cancelled', async () => {
    const user = userEvent.setup();
    render(<TrackersPanel />);

    const trigger = await screen.findByRole('button', { name: 'Disconnect' });
    await user.click(trigger);
    expect(await screen.findByRole('alertdialog', { name: 'Disconnect AniList?' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(trigger).toHaveFocus());
    expect(disconnectTracker).not.toHaveBeenCalled();
  });
});

describe('TrackersPanel connect paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAvailableTrackers.mockResolvedValue([
      { tracker: 'BANGUMI', label: 'Bangumi', auth_kind: 'oauth', available: false },
      { tracker: 'KOMGA', label: 'Komga', auth_kind: 'api_key', available: true },
    ]);
    getConnectedTrackers.mockResolvedValue([]);
  });

  it('shows an unconfigured OAuth tracker as unavailable', async () => {
    render(<TrackersPanel />);
    expect(await screen.findByRole('button', { name: 'Unavailable' })).toBeDisabled();
    expect(screen.getByText(/Not set up on this server/)).toBeInTheDocument();
  });

  it('connects a self-hosted tracker with a server URL and API key', async () => {
    const user = userEvent.setup();
    connectTrackerWithCredentials.mockResolvedValue({
      tracker: 'KOMGA',
      tracker_username: 'reader@example.com',
    });
    render(<TrackersPanel />);

    await user.click(await screen.findByRole('button', { name: 'Connect' }));
    await user.type(screen.getByLabelText('Komga server URL'), 'https://komga.example.com');
    await user.type(screen.getByLabelText('Komga API key'), 'fixture-key');
    await user.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() =>
      expect(connectTrackerWithCredentials).toHaveBeenCalledWith('KOMGA', {
        base_url: 'https://komga.example.com',
        api_key: 'fixture-key',
      }),
    );
    expect(getTrackerAuthorizeUrl).not.toHaveBeenCalled();
  });
});
