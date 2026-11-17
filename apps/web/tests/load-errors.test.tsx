import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ApiError } from '@projekt-manga/api-client';
import { describeLoadError } from '@/lib/load-error';
import { shouldRetry } from '@/lib/query-client';
import { LoadError } from '@/components/load-error';
import { RouteError } from '@/components/route-error';

vi.mock('@/lib/client-diagnostics', () => ({ recordClientError: vi.fn() }));
vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

const http = (status: number, message = `Request failed with status ${status}`) =>
  new ApiError(message, status, 'http');

describe('why something did not load', () => {
  it("keeps the api-client's own words for being offline, unreachable or slow", () => {
    const offline = new ApiError("You're offline. Check your connection.", 0, 'network');
    expect(describeLoadError(offline)).toBe("You're offline. Check your connection.");
    expect(describeLoadError(http(422, 'That category already exists.'))).toBe(
      'That category already exists.',
    );
  });

  it('words an expired sign-in and a bare server failure itself', () => {
    expect(describeLoadError(http(401, 'Unauthorized'))).toMatch(/Sign in again/);
    expect(describeLoadError(http(502))).toMatch(/ran into a problem/);
    // A bare 4xx status says nothing useful to a reader.
    expect(describeLoadError(http(400))).toBeNull();
  });

  it('says nothing for a cancelled request or an error it knows nothing about', () => {
    expect(describeLoadError(new ApiError('Request cancelled', 0, 'aborted'))).toBeNull();
    expect(describeLoadError(new Error('boom'))).toBeNull();
  });
});

describe('which failures get a second try', () => {
  it('retries once what might not fail twice', () => {
    expect(shouldRetry(0, new ApiError('down', 0, 'network'))).toBe(true);
    expect(shouldRetry(0, new ApiError('slow', 0, 'timeout'))).toBe(true);
    expect(shouldRetry(0, http(503))).toBe(true);
    expect(shouldRetry(0, http(429))).toBe(true);
    expect(shouldRetry(1, http(503))).toBe(false);
  });

  it('does not retry an answer that would be the same, or a cancelled request', () => {
    expect(shouldRetry(0, http(404))).toBe(false);
    expect(shouldRetry(0, http(401))).toBe(false);
    expect(shouldRetry(0, http(403))).toBe(false);
    expect(shouldRetry(0, new ApiError('Request cancelled', 0, 'aborted'))).toBe(false);
  });
});

describe('a screen whose content failed to load', () => {
  it('says what failed and why, and asks again, busy until the retry settles', async () => {
    let settle: () => void = () => undefined;
    const onRetry = vi.fn(() => new Promise<void>((resolve) => (settle = resolve)));
    render(
      <LoadError error={http(503)} onRetry={onRetry}>
        Your library didn&apos;t load.
      </LoadError>,
    );

    expect(screen.getByRole('alert')).toHaveTextContent("Your library didn't load.");
    expect(screen.getByRole('alert')).toHaveTextContent('ran into a problem');

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Trying again…' })).toBeDisabled();

    await act(async () => settle());
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
  });
});

describe('a page that failed to render', () => {
  it('fetches the page again on Try again, and links back', () => {
    const retry = vi.fn();
    render(
      <RouteError
        error={new Error('x')}
        retry={retry}
        title="This title didn't load"
        hint="The library server didn't answer."
      />,
    );
    expect(screen.getByRole('heading', { name: "This title didn't load" })).toBeInTheDocument();
    expect(screen.getByText("The library server didn't answer.")).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to library' })).toHaveAttribute('href', '/');

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('says so when this device is offline, and offers downloads', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    render(<RouteError error={new Error('x')} retry={vi.fn()} title="Nope" hint="Server down." />);
    expect(screen.getByRole('alert')).toHaveTextContent("You're offline");
    expect(screen.getByRole('link', { name: 'Downloads' })).toHaveAttribute('href', '/downloads');
  });
});
