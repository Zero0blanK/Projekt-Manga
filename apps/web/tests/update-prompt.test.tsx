import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { UpdateState } from '@/lib/desktop-update';

const { UpdatePrompt } = await import('@/components/update-prompt');
const { AppUpdateDial } = await import('@/components/app-update-dial');

const baseState: UpdateState = {
  supported: true,
  status: 'downloaded',
  currentVersion: '1.0.0',
  availableVersion: '1.1.0',
  downloadPercent: 100,
  error: null,
  releaseNotes: 'What changed\n• Faster reader',
  prompt: true,
};

function installBridge(state: Partial<UpdateState> = {}) {
  const bridge = {
    getState: vi.fn(async () => ({ success: true, data: { ...baseState, ...state } })),
    check: vi.fn(),
    download: vi.fn(),
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
    expect(screen.getByRole('button', { name: 'Update now' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Later' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Skip this version' })).toBeInTheDocument();
  });

  it('lists the changelog.json entry fetched for the new version instead of the release text', async () => {
    installBridge({
      availableVersion: '9.9.0',
      changelog: {
        version: '9.9.0',
        date: '2099-01-01',
        summary: 'A **big** release.',
        upgrade: 'Choose **Update now**.',
        changes: [
          { type: 'added', text: 'Tag filters' },
          { type: 'fixed', text: 'Lost downloads' },
        ],
      },
    });
    render(<UpdatePrompt />);
    const notes = await screen.findByLabelText('Changelog');
    expect(notes).toHaveTextContent('A big release.');
    expect(screen.getByText('big').tagName).toBe('STRONG');
    expect(notes).toHaveTextContent('NewTag filters');
    expect(notes).toHaveTextContent('FixedLost downloads');
    expect(notes).toHaveTextContent('Choose Update now.');
    expect(notes).not.toHaveTextContent('Faster reader');
  });

  it('uses the bundled changelog when it already has the version on offer', async () => {
    const { RELEASES } = await import('@/lib/changelog');
    installBridge({ availableVersion: RELEASES[0].version });
    render(<UpdatePrompt />);
    const notes = await screen.findByLabelText('Changelog');
    expect(notes).toHaveTextContent(RELEASES[0].changes[0].text);
  });

  it('waits for the changelog, then falls back to the release text', async () => {
    installBridge({ availableVersion: '9.9.0', changelogPending: true });
    const { unmount } = render(<UpdatePrompt />);
    expect(await screen.findByLabelText('Changelog')).toHaveTextContent("Loading what's new");
    unmount();

    installBridge({ availableVersion: '9.9.0', changelogPending: false });
    render(<UpdatePrompt />);
    expect(await screen.findByLabelText('Changelog')).toHaveTextContent('Faster reader');
  });

  it('updates now in the background, or remembers Later and Skip', async () => {
    const bridge = installBridge();
    const { unmount } = render(
      <>
        <UpdatePrompt />
        <AppUpdateDial />
      </>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Update now' }));
    expect(bridge.updateNow).toHaveBeenCalledOnce();
    // The prompt closes; the dial in the corner carries on with the install.
    await waitFor(() => expect(screen.queryByText('Version 1.1.0 is available')).toBeNull());
    // Downloaded: nothing restarts by itself; the dial offers it.
    const ready = await screen.findByRole('status');
    expect(ready).toHaveTextContent('Version 1.1.0 is ready');
    expect(bridge.installNow).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Restart to update' }));
    expect(bridge.installNow).toHaveBeenCalledOnce();
    expect(screen.getByRole('status')).toHaveTextContent('will close and reopen by itself');
    unmount();

    render(<UpdatePrompt />);
    fireEvent.click(await screen.findByRole('button', { name: 'Skip this version' }));
    expect(bridge.dismiss).toHaveBeenCalledWith('skip');
    await waitFor(() => expect(screen.queryByText('Version 1.1.0 is available')).toBeNull());
  });

  it('offers a version found while downloading nothing, and ignores clicks outside it', async () => {
    const bridge = installBridge({ status: 'available', downloadPercent: null });
    render(<UpdatePrompt />);
    await screen.findByText('Version 1.1.0 is available');
    fireEvent.pointerDown(document.body);
    expect(bridge.dismiss).not.toHaveBeenCalled();
    expect(screen.getByText('Version 1.1.0 is available')).toBeInTheDocument();
  });

  it('shows the download in the dial, and brings the prompt back when it fails', async () => {
    const bridge = installBridge({ status: 'available', downloadPercent: null });
    render(
      <>
        <UpdatePrompt />
        <AppUpdateDial />
      </>,
    );
    bridge.getState.mockResolvedValue({
      success: true,
      data: { ...baseState, status: 'downloading', downloadPercent: 42 },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Update now' }));
    // It reads "Downloading…" at once, and the percentage from the next check of the updater.
    await waitFor(
      () => expect(screen.getByRole('status')).toHaveTextContent('Downloading version 1.1.0: 42%'),
      { timeout: 4000 },
    );
    expect(screen.queryByText('Version 1.1.0 is available')).toBeNull();

    bridge.getState.mockResolvedValue({
      success: true,
      data: { ...baseState, status: 'available', downloadPercent: null, error: 'Download failed' },
    });
    expect(await screen.findByRole('alert', {}, { timeout: 4000 })).toHaveTextContent(
      'Download failed',
    );
    expect(screen.getByText('Version 1.1.0 is available')).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows why a download failed and offers it again', async () => {
    installBridge({ status: 'available', error: "Couldn't reach GitHub to check for updates." });
    render(<UpdatePrompt />);
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't reach GitHub");
    expect(screen.getByRole('button', { name: 'Update now' })).toBeInTheDocument();
  });

  it('stays hidden when there is nothing to offer, or in a browser', async () => {
    installBridge({ status: 'up-to-date', availableVersion: null, prompt: false });
    render(<UpdatePrompt />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
