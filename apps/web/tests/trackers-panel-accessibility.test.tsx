import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { getConnectedTrackers, disconnectTracker, getTrackerAuthorizeUrl, syncTrackersNow } =
  vi.hoisted(() => ({
    getConnectedTrackers: vi.fn(),
    disconnectTracker: vi.fn(),
    getTrackerAuthorizeUrl: vi.fn(),
    syncTrackersNow: vi.fn(),
  }));

vi.mock('@projekt-manga/api-client', () => ({
  getConnectedTrackers,
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
