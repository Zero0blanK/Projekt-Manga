import { afterEach, describe, expect, it, vi } from 'vitest';
import { showWindowNotification } from '@/lib/window-notification';

const originalPath = window.location.pathname;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState({}, '', originalPath);
});

describe('window notifications', () => {
  it('includes app identity metadata and a destination click handler', () => {
    const created = vi.fn();
    const close = vi.fn();
    class FakeNotification {
      static permission = 'granted';
      onclick: (() => void) | null = null;
      close = close;
      constructor(title: string, options: NotificationOptions) {
        created(title, options, this);
      }
    }
    vi.stubGlobal('Notification', FakeNotification);
    window.history.replaceState({}, '', '/notifications');
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {});

    expect(
      showWindowNotification({
        title: 'New chapters available',
        body: '2 new chapters',
        tag: 'library-update',
        destination: '/notifications',
      }),
    ).toBe(true);
    expect(created).toHaveBeenCalledWith(
      'New chapters available',
      expect.objectContaining({
        body: '2 new chapters',
        icon: `${window.location.origin}/brand/ProjektManga.logo.png`,
        tag: 'projekt-manga:library-update',
        lang: 'en',
      }),
      expect.any(FakeNotification),
    );
    const notification = created.mock.calls[0][2] as FakeNotification;
    notification.onclick?.();
    expect(focus).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('does not attempt a notification without permission', () => {
    const created = vi.fn();
    vi.stubGlobal(
      'Notification',
      class {
        static permission = 'denied';
        constructor() {
          created();
        }
      },
    );
    expect(showWindowNotification({ title: 'Alert', body: 'Body', tag: 'test' })).toBe(false);
    expect(created).not.toHaveBeenCalled();
  });

  it('reports an unavailable OS notification service without throwing', () => {
    vi.stubGlobal(
      'Notification',
      class {
        static permission = 'granted';
        constructor() {
          throw new Error('notification service unavailable');
        }
      },
    );
    expect(showWindowNotification({ title: 'Alert', body: 'Body', tag: 'test' })).toBe(false);
  });
});
