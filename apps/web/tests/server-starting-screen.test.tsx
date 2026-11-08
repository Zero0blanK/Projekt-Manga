import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { ServerStartingScreen } from '@/components/server-starting-screen';

afterEach(() => {
  vi.useRealTimers();
});

describe('ServerStartingScreen', () => {
  it('says it is starting, and explains a slow start after a few seconds', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    render(<ServerStartingScreen startedAt={9_000} />);
    expect(screen.getByRole('status')).toHaveTextContent('Starting Projekt Manga');
    expect(screen.queryByText(/after an update/)).toBeNull();

    act(() => {
      vi.advanceTimersByTime(9_000);
    });
    expect(screen.getByRole('status')).toHaveTextContent(/after an update.*\(10s\)/);
  });
});
