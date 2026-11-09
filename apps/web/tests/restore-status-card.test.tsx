import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RestoreStatusCard } from '@/components/restore-status-card';
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

const start = (value: object) =>
  act(() => {
    localStorage.setItem(key, JSON.stringify(value));
    window.dispatchEvent(new Event('projekt-manga-restore-started'));
  });

describe('RestoreStatusCard', () => {
  it('shows a running restore without taking over the app', () => {
    const { container } = render(<RestoreStatusCard />);
    start(pending);

    expect(screen.getByRole('status', { name: 'Restoring your library' })).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: 'Restore in progress' })).toBeTruthy();
    expect(screen.getByText(/keep reading if you like/i)).toBeTruthy();
    expect(container.querySelector('[aria-modal="true"]')).toBeNull();
  });

  it('asks for acknowledgement of a failed restore', async () => {
    const { container } = render(<RestoreStatusCard />);
    start({ ...pending, failed: true });

    expect(screen.getByRole('alert', { name: 'Restore could not be completed' })).toBeTruthy();
    expect(screen.getByText(/transaction was rolled back/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() => expect(container.querySelector('section')).toBeNull());
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('renders row progress, then a cancellation to acknowledge', async () => {
    const { container } = render(<RestoreStatusCard />);
    start({ ...pending, progress: { phase: 'Restoring chapters', completed: 4, total: 10 } });
    const bar = screen.getByRole('progressbar', { name: 'Restore in progress' });
    expect(bar.getAttribute('aria-valuenow')).toBe('4');
    expect(screen.getByText(/4 of 10 records/)).toBeTruthy();

    start({ ...pending, cancelled: true });
    expect(screen.getByRole('alert', { name: 'Restore cancelled' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() => expect(container.querySelector('section')).toBeNull());
  });

  it('shows saved progress straight away after a reload', () => {
    currentUser.user = { id: 'account-1', email: 'reader@example.test' };
    localStorage.setItem(
      key,
      JSON.stringify({
        ...pending,
        owner: 'account-1',
        progress: { phase: 'Restoring chapters', completed: 4, total: 10 },
      }),
    );

    render(<RestoreStatusCard />);

    expect(screen.getByRole('status', { name: 'Restoring your library' })).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('4');
    expect(screen.getByText(/Restoring chapters · 4 of 10 records/)).toBeTruthy();
  });

  it('explains an account mismatch without its progress, and can stop tracking it', async () => {
    currentUser.user = { id: 'account-2', email: 'other@example.test' };
    localStorage.setItem(
      key,
      JSON.stringify({
        ...pending,
        owner: 'account-1',
        progress: { phase: 'Writing', completed: 4, total: 10 },
      }),
    );

    const { container } = render(<RestoreStatusCard />);

    expect(screen.getByRole('alert', { name: 'Restore belongs to another account' })).toBeTruthy();
    expect(screen.queryByText(/4 of 10 records/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign out to switch accounts' })).toBeTruthy();
    // Its account may be gone for good; this used to leave the app blocked forever.
    fireEvent.click(screen.getByRole('button', { name: 'Stop tracking this restore' }));
    await waitFor(() => expect(container.querySelector('section')).toBeNull());
    expect(localStorage.getItem(key)).toBeNull();
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

    const { rerender } = render(<RestoreStatusCard />);
    expect(screen.getByRole('alert', { name: 'Restore belongs to another account' })).toBeTruthy();

    currentUser.user = { id: 'account-1', email: 'reader@example.test' };
    rerender(<RestoreStatusCard />);

    expect(screen.getByRole('status', { name: 'Restoring your library' })).toBeTruthy();
    expect(screen.getByText(/Writing · 4 of 10 records/)).toBeTruthy();
  });

  it('does not expose progress or cancellation before session ownership is known', () => {
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

    render(<RestoreStatusCard />);

    expect(screen.getByRole('status', { name: 'Checking restore account' })).toBeTruthy();
    expect(screen.queryByText(/4 of 10 records/)).toBeNull();
    expect(screen.queryByRole('button', { name: /cancel before processing/i })).toBeNull();
  });

  it('asks the reader to refresh and acknowledge an unknown result', async () => {
    const { container } = render(<RestoreStatusCard />);
    start({ ...pending, statusUnknown: true });

    expect(
      screen.getByRole('alert', { name: 'Restore result could not be confirmed' }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh and acknowledge' }));
    await waitFor(() => expect(container.querySelector('section')).toBeNull());
    expect(localStorage.getItem(key)).toBeNull();
    expect(getCurrentUser).toHaveBeenCalledTimes(2);
    expect(queryClient.getQueryData(queryKeys.session)).toBeNull();
  });
});
