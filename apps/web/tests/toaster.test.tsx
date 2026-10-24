import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Toaster } from '@/components/ui/toaster';
import { toast, useToast } from '@/hooks/use-toast';

function Harness() {
  const { dismiss, toasts } = useToast();
  return (
    <>
      <button onClick={() => dismiss()}>Dismiss all</button>
      <output aria-label="Retained notifications">{toasts.length}</output>
      <Toaster />
    </>
  );
}

describe('toast dismissal', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss all' }));
    act(() => vi.runAllTimers());
    vi.useRealTimers();
  });
  it('automatically hides a normal toast after five seconds', () => {
    render(<Harness />);
    act(() => {
      toast({ description: 'Saved' });
    });
    expect(screen.getByText('Saved')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });
  it.each([0, 1000])(
    'automatically dismisses a new toast %i ms after a paused toast is closed',
    (delay) => {
      render(<Harness />);
      let first: ReturnType<typeof toast>;
      act(() => {
        first = toast({ description: 'First' });
      });
      fireEvent(window, new Event('blur'));
      act(() => first.dismiss());
      act(() => vi.advanceTimersByTime(delay));
      fireEvent(window, new Event('focus'));
      act(() => {
        toast({ description: 'Second' });
      });
      act(() => vi.advanceTimersByTime(5000));
      expect(screen.queryByText('Second')).not.toBeInTheDocument();
    },
  );
  it('keeps custom durations independent when another toast closes', () => {
    render(<Harness />);
    act(() => {
      toast({ description: 'Short', duration: 1000 });
      toast({ description: 'Long', duration: 8000 });
    });
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.queryByText('Short')).not.toBeInTheDocument();
    expect(screen.getByText('Long')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(6999));
    expect(screen.getByText('Long')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByText('Long')).not.toBeInTheDocument();
  });
  it('pauses while the window is blurred and resumes on focus', () => {
    render(<Harness />);
    act(() => {
      toast({ description: 'Reading' });
    });
    act(() => vi.advanceTimersByTime(2000));
    fireEvent(window, new Event('blur'));
    act(() => vi.advanceTimersByTime(10000));
    expect(screen.getByText('Reading')).toBeInTheDocument();
    fireEvent(window, new Event('focus'));
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.queryByText('Reading')).not.toBeInTheDocument();
  });
  it('closes manually and removes dismissed state after one second', () => {
    render(<Harness />);
    act(() => {
      toast({ description: 'Dismiss me' });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Close notification' }));
    expect(screen.queryByText('Dismiss me')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Retained notifications')).toHaveTextContent('1');
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByLabelText('Retained notifications')).toHaveTextContent('0');
  });
});
