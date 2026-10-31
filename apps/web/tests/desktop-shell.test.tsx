import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { parseDesktopCommand } from '@/lib/desktop-commands';
import { CloseToTrayControl } from '@/components/settings/startup-background-control';

const push = vi.fn();
const updateLibrary = vi.fn(async () => undefined);
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));
vi.mock('@/lib/library-store', () => ({
  useMangaLibrary: () => ({
    manga: [{ id: 'title-1', title: 'Frieren' }],
  }),
}));
const downloads = { progress: null as number | null };
const unread = { titles: [] as string[] };
vi.mock('@/components/downloads/row-data', () => ({
  useDownloadQueueProgress: () => downloads.progress,
}));
vi.mock('@/lib/unread-updates', () => ({ useUnreadUpdateTitles: () => unread.titles }));
vi.mock('@/components/library/update-library-button', () => ({
  useUpdateLibrary: () => ({ updateLibrary, running: false, titleCount: 1, progress: null }),
}));

import { CommandPalette } from '@/components/command-palette';
import { DesktopIntegration } from '@/components/desktop-integration';

// cmdk measures its list; jsdom has no layout, so these only need to exist.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
});

afterEach(() => {
  delete (window as unknown as { desktop?: unknown }).desktop;
  push.mockClear();
  updateLibrary.mockClear();
});

describe('desktop commands', () => {
  it('accepts only known commands with paths inside the app', () => {
    expect(parseDesktopCommand({ type: 'update-library' })).toEqual({ type: 'update-library' });
    expect(parseDesktopCommand({ type: 'navigate', path: '/settings#about' })).toEqual({
      type: 'navigate',
      path: '/settings#about',
    });
    for (const raw of [
      null,
      'navigate',
      { type: 'quit' },
      { type: 'navigate' },
      { type: 'navigate', path: 'https://evil.test/' },
      { type: 'navigate', path: '//evil.test/' },
      { type: 'navigate', path: '/\\evil' },
      { type: 'navigate', path: 'javascript:alert(1)' },
      { type: 'navigate', path: `/${'x'.repeat(300)}` },
    ])
      expect(parseDesktopCommand(raw)).toBeNull();
  });

  it('runs tray and menu commands and reports update progress', async () => {
    let send: ((command: unknown) => void) | null = null;
    const setProgress = vi.fn(async () => undefined);
    (window as unknown as { desktop?: unknown }).desktop = {
      commands: {
        subscribe: (listener: (command: unknown) => void) => {
          send = listener;
          return () => {
            send = null;
          };
        },
      },
      window: { setProgress },
    };
    const { unmount } = render(<DesktopIntegration />);
    await waitFor(() => expect(send).not.toBeNull());
    act(() => send!({ type: 'navigate', path: '/downloads' }));
    expect(push).toHaveBeenCalledWith('/downloads');
    act(() => send!({ type: 'navigate', path: 'https://evil.test/' }));
    expect(push).toHaveBeenCalledTimes(1);
    act(() => send!({ type: 'update-library' }));
    expect(updateLibrary).toHaveBeenCalledTimes(1);
    expect(setProgress).toHaveBeenCalledWith(null);
    unmount();
    expect(send).toBeNull();
  });

  it('shows download progress and the new-chapter count on the taskbar button', async () => {
    const setProgress = vi.fn(async () => undefined);
    const setBadge = vi.fn(async () => undefined);
    (window as unknown as { desktop?: unknown }).desktop = {
      commands: { subscribe: () => () => undefined },
      window: { setProgress, setBadge },
    };
    downloads.progress = 0.4567;
    unread.titles = ['a', 'b', 'c'];
    const { unmount } = render(<DesktopIntegration />);
    // No library update running: the download queue's progress, rounded.
    await waitFor(() => expect(setProgress).toHaveBeenCalledWith(0.46));
    // jsdom has no canvas, so no image is drawn here; the count still goes over.
    expect(setBadge.mock.calls[0][0]).toBe(3);
    unmount();
    expect(setProgress).toHaveBeenLastCalledWith(null);
    expect(setBadge).toHaveBeenLastCalledWith(0, undefined);
    downloads.progress = null;
    unread.titles = [];
  });
});

describe('command palette', () => {
  it('opens with Ctrl+Shift+P, finds a library title and goes to it', async () => {
    render(<CommandPalette />);
    fireEvent.keyDown(window, { key: 'P', ctrlKey: true, shiftKey: true });
    const input = await screen.findByPlaceholderText('Search titles, pages, settings…');
    fireEvent.change(input, { target: { value: 'Frieren' } });
    fireEvent.click(await screen.findByText('Frieren'));
    expect(push).toHaveBeenCalledWith('/manga/title-1');
  });

  it('leaves Ctrl+K to the search box', () => {
    render(<CommandPalette />);
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(screen.queryByPlaceholderText('Search titles, pages, settings…')).toBeNull();
  });

  it('runs the library update action', async () => {
    render(<CommandPalette />);
    fireEvent.keyDown(window, { key: 'p', metaKey: true, shiftKey: true });
    fireEvent.click(await screen.findByText('Update library'));
    expect(updateLibrary).toHaveBeenCalledTimes(1);
  });
});

describe('close to tray setting', () => {
  it('appears only in the desktop app and saves the choice', async () => {
    const { container, unmount } = render(<CloseToTrayControl />);
    expect(container).toBeEmptyDOMElement();
    unmount();
    const setEnabled = vi.fn(async (enabled: boolean) => ({
      success: true,
      data: { supported: true, enabled },
    }));
    (window as unknown as { desktop?: unknown }).desktop = {
      closeToTray: {
        getState: async () => ({ success: true, data: { supported: true, enabled: false } }),
        setEnabled,
      },
    };
    render(<CloseToTrayControl />);
    const toggle = await screen.findByRole('switch', {
      name: 'Keep Projekt Manga running in the tray when the window closes',
    });
    fireEvent.click(toggle);
    await waitFor(() => expect(setEnabled).toHaveBeenCalledWith(true));
  });
});
