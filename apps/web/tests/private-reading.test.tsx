import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { actions } from '@/lib/app-store';
import { INCOGNITO_MODE, isSourceIncognito, setAppIncognito } from '@/lib/incognito';
import { DesktopPrivacyControls } from '@/components/settings/desktop-privacy-controls';

vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));

afterEach(() => {
  act(() => actions.setSetting(INCOGNITO_MODE, false));
  delete (window as unknown as { desktop?: unknown }).desktop;
});

describe('app-wide incognito', () => {
  it('makes every source private, which is what the readers check before saving', () => {
    expect(isSourceIncognito('any-source')).toBe(false);
    act(() => setAppIncognito(true));
    expect(isSourceIncognito('any-source')).toBe(true);
  });
});

function installDesktop(enabled = false) {
  const lock = {
    getState: vi.fn(async () => ({
      success: true,
      data: { enabled, idleMinutes: enabled ? 15 : 0, locked: false },
    })),
    set: vi.fn(async (input: { idleMinutes: number }) => ({
      success: true,
      data: { enabled: true, idleMinutes: input.idleMinutes, locked: false },
    })),
    clear: vi.fn(async () => ({ success: false, message: 'The current PIN is wrong.' })),
    lockNow: vi.fn(async () => ({ success: true })),
  };
  const capture = {
    getHidden: vi.fn(async () => ({ success: true, data: false })),
    setHidden: vi.fn(async (hidden: boolean) => ({ success: true, data: hidden })),
  };
  (window as unknown as { desktop?: unknown }).desktop = { lock, capture };
  return { lock, capture };
}

describe('desktop privacy settings', () => {
  it('shows nothing in a browser', () => {
    const { container } = render(<DesktopPrivacyControls />);
    expect(container).toBeEmptyDOMElement();
  });

  it('sets a PIN only when both entries match', async () => {
    const { lock } = installDesktop();
    render(<DesktopPrivacyControls />);
    fireEvent.click(await screen.findByRole('button', { name: 'Set a PIN' }));
    const [pin, repeat] = screen
      .getByRole('form', { name: 'App lock' })
      .querySelectorAll('input[type="password"]');
    fireEvent.change(pin, { target: { value: '2468' } });
    fireEvent.change(repeat, { target: { value: '1357' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("don't match");
    expect(lock.set).not.toHaveBeenCalled();
    fireEvent.change(repeat, { target: { value: '2468' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(lock.set).toHaveBeenCalledWith({ newPin: '2468', idleMinutes: 5 }));
  });

  it('shows the main process refusing to turn the lock off with a wrong PIN', async () => {
    const { lock } = installDesktop(true);
    render(<DesktopPrivacyControls />);
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off' }));
    const [current] = screen
      .getByRole('form', { name: 'App lock' })
      .querySelectorAll('input[type="password"]');
    fireEvent.change(current, { target: { value: '0000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Turn off app lock' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('wrong');
    expect(lock.clear).toHaveBeenCalledWith({ currentPin: '0000' });
  });

  it('hides the window from capture', async () => {
    const { capture } = installDesktop();
    render(<DesktopPrivacyControls />);
    fireEvent.click(
      await screen.findByRole('switch', {
        name: 'Hide Projekt Manga from screenshots and screen sharing',
      }),
    );
    await waitFor(() => expect(capture.setHidden).toHaveBeenCalledWith(true));
  });
});
