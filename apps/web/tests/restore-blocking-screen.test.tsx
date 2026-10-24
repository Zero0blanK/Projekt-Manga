import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RestoreBlockingScreen } from '@/components/restore-blocking-screen';
import { queryClient, queryKeys } from '@/lib/query-client';

const { currentUser, getCurrentUser } = vi.hoisted(() => ({
  currentUser: { user: null as null | { id: string; email: string }, loading: false },
  getCurrentUser: vi.fn(),
}));
vi.mock('@/lib/session-resource', () => ({ useCurrentUser: () => currentUser }));
vi.mock('@projekt-manga/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@projekt-manga/api-client')>()),
  getCurrentUser,
}));

const key = 'projekt-manga-pending-restore';
const pending = {
  id: 'restore-id',
  owner: 'anonymous',
  settings: {},
  skippedDownloads: 0,
  startedAt: Date.now(),
};

const values = new Map<string, string>();
const localStorageMock = {
  getItem: (name: string) => values.get(name) ?? null,
  setItem: (name: string, value: string) => values.set(name, value),
  removeItem: (name: string) => values.delete(name),
  clear: () => values.clear(),
};

beforeEach(() => {
  currentUser.user = null;
  currentUser.loading = false;
  getCurrentUser.mockReset().mockResolvedValue({ user: null });
  queryClient.setQueryData(queryKeys.session, null);
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: localStorageMock,
  });
});
afterEach(() => {
  localStorageMock.clear();
  queryClient.clear();
});

describe('RestoreBlockingScreen', () => {
  it('announces indeterminate progress and keeps keyboard focus within the modal', async () => {
    const { container } = render(<RestoreBlockingScreen />);
    act(() => {
      localStorage.setItem(key, JSON.stringify(pending));
      window.dispatchEvent(new Event('projekt-manga-restore-started'));
    });

    const dialog = screen.getByRole('alertdialog', { name: 'Restoring your library' });
    expect(dialog).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: 'Restore in progress' })).toBeTruthy();
    const heading = screen.getByRole('heading', { name: 'Restoring your library' });
    await waitFor(() => expect(document.activeElement).toBe(heading));

    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(heading);
    expect(container.querySelector('[aria-modal="true"]')).toBeTruthy();
  });

  it('keeps a failed restore blocked until the user acknowledges it', async () => {
    const { container } = render(<RestoreBlockingScreen />);
    act(() => {
      localStorage.setItem(key, JSON.stringify({ ...pending, failed: true }));
      window.dispatchEvent(new Event('projekt-manga-restore-started'));
    });

    expect(screen.getByText(/transaction was rolled back/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() => expect(container.querySelector('[role="alertdialog"]')).toBeNull());
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('renders determinate row progress and keeps a cancelled restore blocked for acknowledgement', async () => {
    const { container } = render(<RestoreBlockingScreen />);
    act(() => {
      localStorage.setItem(
        key,
        JSON.stringify({
          ...pending,
          progress: { phase: 'Restoring chapters', completed: 4, total: 10 },
        }),
      );
      window.dispatchEvent(new Event('projekt-manga-restore-started'));
    });
    const bar = screen.getByRole('progressbar', { name: 'Restore in progress' });
    expect(bar.getAttribute('aria-valuenow')).toBe('4');
    expect(screen.getByText(/4 of 10 records/)).toBeTruthy();

    act(() => {
      localStorage.setItem(key, JSON.stringify({ ...pending, cancelled: true }));
      window.dispatchEvent(new Event('projekt-manga-restore-started'));
    });
    expect(screen.getByRole('alertdialog', { name: 'Restore cancelled' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() => expect(container.querySelector('[role="alertdialog"]')).toBeNull());
  });

  it('restores persisted progress immediately when the app mounts after a reload', () => {
    currentUser.user = { id: 'account-1', email: 'reader@example.test' };
    localStorage.setItem(
      key,
      JSON.stringify({
        ...pending,
        owner: 'account-1',
        progress: { phase: 'Restoring chapters', completed: 4, total: 10 },
      }),
    );

    render(<RestoreBlockingScreen />);

    expect(screen.getByRole('alertdialog', { name: 'Restoring your library' })).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('4');
    expect(screen.getByText(/Restoring chapters · 4 of 10 records/)).toBeTruthy();
  });

  it('keeps a restore blocked and explains an account mismatch without stale progress', () => {
    currentUser.user = { id: 'account-2', email: 'other@example.test' };
    localStorage.setItem(
      key,
      JSON.stringify({
        ...pending,
        owner: 'account-1',
        progress: { phase: 'Writing', completed: 4, total: 10 },
      }),
    );

    render(<RestoreBlockingScreen />);

    expect(
      screen.getByRole('alertdialog', { name: 'Restore belongs to another account' }),
    ).toBeTruthy();
    expect(screen.getByText(/switch back to the account that started the restore/i)).toBeTruthy();
    expect(screen.queryByText(/4 of 10 records/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign out to switch accounts' })).toBeTruthy();
    expect(screen.getByText('Current account: other@example.test')).toBeTruthy();
    expect(localStorage.getItem(key)).not.toBeNull();
  });

  it('reveals the saved progress when the original account becomes active again', () => {
    currentUser.user = { id: 'account-2', email: 'other@example.test' };
    localStorage.setItem(
      key,
      JSON.stringify({
        ...pending,
        owner: 'account-1',
        progress: { phase: 'Writing', completed: 4, total: 10 },
      }),
    );

    const { rerender } = render(<RestoreBlockingScreen />);
    expect(
      screen.getByRole('alertdialog', { name: 'Restore belongs to another account' }),
    ).toBeTruthy();

    currentUser.user = { id: 'account-1', email: 'reader@example.test' };
    rerender(<RestoreBlockingScreen />);

    expect(screen.getByRole('alertdialog', { name: 'Restoring your library' })).toBeTruthy();
    expect(screen.getByText(/Writing · 4 of 10 records/)).toBeTruthy();
  });

  it('does not expose persisted progress or cancellation before session ownership is known', () => {
    currentUser.user = null;
    currentUser.loading = true;
    localStorage.setItem(
      key,
      JSON.stringify({
        ...pending,
        owner: 'account-1',
        progress: { phase: 'Writing', completed: 4, total: 10 },
      }),
    );

    render(<RestoreBlockingScreen />);

    expect(screen.getByRole('alertdialog', { name: 'Checking restore account' })).toBeTruthy();
    expect(screen.getByText(/checking which account owns this restore/i)).toBeTruthy();
    expect(screen.queryByText(/4 of 10 records/)).toBeNull();
    expect(screen.queryByRole('button', { name: /cancel before processing/i })).toBeNull();
  });

  it('keeps an unknown restore result blocked until the user refreshes and acknowledges it', async () => {
    const { container } = render(<RestoreBlockingScreen />);
    act(() => {
      localStorage.setItem(key, JSON.stringify({ ...pending, statusUnknown: true }));
      window.dispatchEvent(new Event('projekt-manga-restore-started'));
    });

    expect(
      screen.getByRole('alertdialog', { name: 'Restore result could not be confirmed' }),
    ).toBeTruthy();
    expect(screen.getByText(/cannot confirm whether it completed/i)).toBeTruthy();
    const acknowledge = screen.getByRole('button', { name: 'Refresh and acknowledge' });
    fireEvent.click(acknowledge);
    await waitFor(() => expect(container.querySelector('[role="alertdialog"]')).toBeNull());
    expect(localStorage.getItem(key)).toBeNull();
    expect(getCurrentUser).toHaveBeenCalledTimes(2);
    expect(queryClient.getQueryData(queryKeys.session)).toBeNull();
  });
});
