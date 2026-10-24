import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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

  it('does not divide by zero before the total is known', () => {
    progress.value = { done: 0, total: 0, found: 0, title: 'Starting' };
    render(<LibraryUpdateDial />);

    expect(screen.getByText('0%')).toBeInTheDocument();
  });
});
