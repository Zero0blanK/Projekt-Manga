import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { UpdateState } from '@/lib/desktop-update';

const { UpdatePrompt } = await import('@/components/update-prompt');

const baseState: UpdateState = {
  supported: true,
  status: 'downloaded',
  currentVersion: '1.0.0',
  availableVersion: '1.1.0',
  downloadPercent: 100,
  error: null,
  autoDownload: true,
  releaseNotes: 'What changed\n• Faster reader',
  prompt: true,
};

function installBridge(state: Partial<UpdateState> = {}) {
  const bridge = {
    getState: vi.fn(async () => ({ success: true, data: { ...baseState, ...state } })),
    check: vi.fn(),
    download: vi.fn(),
    setAutoDownload: vi.fn(),
    installNow: vi.fn(),
    updateNow: vi.fn(async () => ({ success: true })),
    dismiss: vi.fn(async () => ({ success: true })),
  };
  Object.defineProperty(window, 'desktop', { configurable: true, value: { update: bridge } });
  return bridge;
}

afterEach(() => {
  delete (window as { desktop?: unknown }).desktop;
});

describe('UpdatePrompt', () => {
  it('shows the changelog of a new version with the three choices', async () => {
    installBridge();
    render(<UpdatePrompt />);
    expect(await screen.findByText('Version 1.1.0 is available')).toBeInTheDocument();
    expect(screen.getByLabelText('Changelog')).toHaveTextContent('Faster reader');
    expect(screen.getByRole('button', { name: 'Update now' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Later' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Skip this version' })).toBeInTheDocument();
  });

  it('updates now, or remembers Later and Skip', async () => {
    const bridge = installBridge();
    const { unmount } = render(<UpdatePrompt />);
    fireEvent.click(await screen.findByRole('button', { name: 'Update now' }));
    expect(bridge.updateNow).toHaveBeenCalledOnce();
    expect(await screen.findByRole('status')).toHaveTextContent('Restarting to install');
    unmount();

    render(<UpdatePrompt />);
    fireEvent.click(await screen.findByRole('button', { name: 'Skip this version' }));
    expect(bridge.dismiss).toHaveBeenCalledWith('skip');
    await waitFor(() => expect(screen.queryByText('Version 1.1.0 is available')).toBeNull());
  });

  it('stays hidden when there is nothing to offer, or in a browser', async () => {
    installBridge({ status: 'up-to-date', availableVersion: null, prompt: false });
    render(<UpdatePrompt />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
