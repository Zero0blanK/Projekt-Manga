import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StartupBackgroundControl } from '@/components/settings/startup-background-control';

const toast = vi.fn();
vi.mock('@/hooks/use-toast', () => ({ toast: (...args: unknown[]) => toast(...args) }));

function installBridge(supported = true) {
  const getState = vi.fn(async () => ({ success: true, data: { supported, enabled: false } }));
  const setEnabled = vi.fn(async (enabled: boolean) => ({
    success: true,
    data: { supported, enabled },
  }));
  (window as unknown as { desktop?: unknown }).desktop = {
    startupBackground: { getState, setEnabled },
  };
  return { getState, setEnabled };
}

afterEach(() => {
  delete (window as unknown as { desktop?: unknown }).desktop;
  toast.mockClear();
});

describe('background startup setting', () => {
  it('does not show OS controls in a plain browser', () => {
    const { container } = render(<StartupBackgroundControl />);
    expect(container).toBeEmptyDOMElement();
  });

  it('does not offer an OS setting in unsupported desktop builds', async () => {
    const bridge = installBridge(false);
    const { container } = render(<StartupBackgroundControl />);
    await waitFor(() => expect(bridge.getState).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('enables background startup and shows the applied state', async () => {
    const bridge = installBridge();
    render(<StartupBackgroundControl />);
    const toggle = await screen.findByRole('switch', {
      name: 'Run Projekt Manga in background at sign-in',
    });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(toggle);
    await waitFor(() => expect(bridge.setEnabled).toHaveBeenCalledWith(true));
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
  });

  it('keeps the old state and reports a failed OS write', async () => {
    const bridge = installBridge();
    bridge.setEnabled.mockRejectedValueOnce(new Error('OS denied startup item'));
    render(<StartupBackgroundControl />);
    const toggle = await screen.findByRole('switch', {
      name: 'Run Projekt Manga in background at sign-in',
    });
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' })),
    );
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });
});
