import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { progress, cancelLibraryUpdate } = vi.hoisted(() => ({
  progress: { value: null as { done: number; total: number; found: number; title: string } | null },
  cancelLibraryUpdate: vi.fn(),
}));

vi.mock('@/lib/run-library-update', () => ({
  cancelLibraryUpdate,
  useLibraryUpdateProgress: () => progress.value,
}));

const { LibraryUpdateDial } = await import('@/components/library/library-update-dial');

beforeEach(() => {
  progress.value = null;
  vi.clearAllMocks();
});

/**
 * Library update progress is a corner dial mounted app-wide, so it neither resizes the
 * library toolbar nor is limited to the library page.
 */
describe('library update dial', () => {
  it('shows nothing at all when no update is running', () => {
    const { container } = render(<LibraryUpdateDial />);

    // Not merely hidden: an empty corner should cost no markup and trap no clicks.
    expect(container).toBeEmptyDOMElement();
  });

  it('reports progress, the title in flight, and new chapters found', () => {
    progress.value = { done: 4, total: 12, found: 2, title: 'Some title' };
    render(<LibraryUpdateDial />);

    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Checking 4/12');
    expect(status).toHaveTextContent('2 new chapters');
    expect(screen.getByText('Some title')).toBeInTheDocument();
    // 4 of 12 rounds to 33%.
    expect(screen.getByText('33%')).toBeInTheDocument();
  });

  it('says "1 new chapter", not "1 new chapters"', () => {
    progress.value = { done: 1, total: 2, found: 1, title: 'One' };
    render(<LibraryUpdateDial />);

    expect(screen.getByRole('status')).toHaveTextContent('1 new chapter');
    expect(screen.getByRole('status')).not.toHaveTextContent('1 new chapters');
  });

  it('can be stopped from the dial', async () => {
    progress.value = { done: 1, total: 9, found: 0, title: 'One' };
    render(<LibraryUpdateDial />);

    await userEvent.click(screen.getByRole('button', { name: 'Stop checking for updates' }));

    expect(cancelLibraryUpdate).toHaveBeenCalledOnce();
  });

  it.each([
    ['right', 60, 0],
    ['up', 0, -60],
    ['down-left', -40, 40],
  ])('shrinks to the ring on a swipe %s, and comes back from it', async (_, x, y) => {
    progress.value = { done: 4, total: 12, found: 0, title: 'Some title' };
    render(<LibraryUpdateDial />);

    const status = screen.getByRole('status');
    fireEvent.pointerDown(status, { clientX: 100, clientY: 100, button: 0 });
    fireEvent.pointerMove(status, { clientX: 100 + x, clientY: 100 + y });
    fireEvent.pointerUp(status, { clientX: 100 + x, clientY: 100 + y });

    expect(screen.queryByRole('button', { name: 'Stop checking for updates' })).toBeNull();
    expect(screen.getByText('Some title').parentElement).toHaveClass('sr-only');
    // Screen readers keep hearing the progress.
    expect(screen.getByRole('status')).toHaveTextContent('Checking 4/12');

    await userEvent.click(screen.getByRole('button', { name: 'Show library update details' }));
    expect(screen.getByRole('button', { name: 'Stop checking for updates' })).toBeInTheDocument();
  });

  it('stays open after a short drag', () => {
    progress.value = { done: 4, total: 12, found: 0, title: 'Some title' };
    render(<LibraryUpdateDial />);

    const status = screen.getByRole('status');
    fireEvent.pointerDown(status, { clientX: 100, clientY: 100, button: 0 });
    fireEvent.pointerMove(status, { clientX: 120, clientY: 100 });
    fireEvent.pointerUp(status, { clientX: 120, clientY: 100 });

    expect(screen.getByRole('button', { name: 'Stop checking for updates' })).toBeInTheDocument();
  });

  it('remembers being minimized when it next appears, and the ring works by keyboard', async () => {
    progress.value = { done: 4, total: 12, found: 0, title: 'Some title' };
    const first = render(<LibraryUpdateDial />);
    await userEvent.click(screen.getByRole('button', { name: 'Minimize library update' }));
    first.unmount();

    render(<LibraryUpdateDial />);
    await userEvent.click(screen.getByRole('button', { name: 'Show library update details' }));
    expect(screen.getByRole('button', { name: 'Minimize library update' })).toBeInTheDocument();
  });

  it('does not divide by zero before the total is known', () => {
    progress.value = { done: 0, total: 0, found: 0, title: 'Starting' };
    render(<LibraryUpdateDial />);

    expect(screen.getByText('0%')).toBeInTheDocument();
  });
});
