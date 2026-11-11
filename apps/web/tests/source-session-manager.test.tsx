import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SourceBrowserSessionStatus } from '@projekt-manga/types';
import { parsePastedCookies, parsePastedUserAgent } from '@/lib/source-browser';
import { SourceSessionManager } from '@/components/discover/source-session-manager';

const api = vi.hoisted(() => ({
  get: vi.fn(),
  save: vi.fn(),
  clear: vi.fn(),
}));
vi.mock('@projekt-manga/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@projekt-manga/api-client')>()),
  getSourceBrowserSession: (...args: unknown[]) => api.get(...args),
  saveSourceBrowserSession: (...args: unknown[]) => api.save(...args),
  clearSourceBrowserSession: (...args: unknown[]) => api.clear(...args),
}));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:159.0) Gecko/20100101 Firefox/159.0';
const empty: SourceBrowserSessionStatus = {
  sourceId: 'manhuaus',
  hosts: [],
  updatedAt: null,
  userAgent: null,
  cookies: [],
};
const savedSession: SourceBrowserSessionStatus = {
  sourceId: 'manhuaus',
  hosts: ['manhuaus.com'],
  updatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  userAgent: UA,
  cookies: [
    { name: 'cf_clearance', domain: 'manhuaus.com', expires: Date.now() / 1000 + 3600 * 5 },
  ],
};

function renderManager(props: { onSaved?: () => void; hideWhenEmpty?: boolean } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SourceSessionManager
        sourceId="manhuaus"
        sourceName="ManhuaUS"
        siteUrl="https://manhuaus.com/"
        {...props}
      />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.clearAllMocks();
  Reflect.deleteProperty(window, 'desktop');
});

describe('pasted sessions', () => {
  it('takes a bare clearance value as cf_clearance on the site and its subdomains', () => {
    expect(parsePastedCookies('  abc.def-123  ', 'www.manhuaus.com')).toEqual([
      {
        name: 'cf_clearance',
        value: 'abc.def-123',
        domain: 'manhuaus.com',
        hostOnly: false,
        path: '/',
        secure: true,
        httpOnly: false,
      },
    ]);
  });

  it('takes a whole Cookie header', () => {
    const cookies = parsePastedCookies(
      'Cookie: cf_clearance=abc; _ga=GA1.2; cf_clearance=dup',
      'manhuaus.com',
    );
    expect(cookies.map((cookie) => [cookie.name, cookie.value])).toEqual([
      ['cf_clearance', 'abc'],
      ['_ga', 'GA1.2'],
    ]);
  });

  it('keeps only the User-Agent when other headers were copied along with it', () => {
    expect(parsePastedUserAgent(`User-Agent: ${UA}\nAccept-Language: en-US,en;q=0.9`)).toBe(UA);
    // A single-line box joins the lines with a space.
    expect(parsePastedUserAgent(`User-Agent: ${UA} Accept-Language: en-US,en;q=0.9`)).toBe(UA);
    expect(parsePastedUserAgent(`Accept: */*\nUser-Agent: ${UA}`)).toBe(UA);
    expect(parsePastedUserAgent(UA)).toBe(UA);
  });

  it('refuses text that is not a cookie or a User-Agent', () => {
    expect(() => parsePastedCookies('', 'manhuaus.com')).toThrow(/Paste the cookie/);
    expect(() => parsePastedCookies('has space', 'manhuaus.com')).toThrow(
      /doesn’t look like a cookie/,
    );
    expect(() => parsePastedCookies('bad name=1', 'manhuaus.com')).toThrow(
      /doesn’t look like a cookie/,
    );
    expect(() => parsePastedUserAgent('   ')).toThrow(/User-Agent/);
    expect(() => parsePastedUserAgent('Mozilla/5.0 ✓')).toThrow(/User-Agent/);
  });
});

describe('SourceSessionManager', () => {
  it('saves a new session, then shows it instead of empty fields', async () => {
    api.get.mockResolvedValue(empty);
    api.save.mockResolvedValue(savedSession);
    const onSaved = vi.fn();
    renderManager({ onSaved });

    fireEvent.click(await screen.findByText('Paste a session from your browser'));
    fireEvent.change(screen.getByLabelText('Cookie'), { target: { value: 'clear-value' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save session' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/User-Agent/);
    expect(api.save).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('User-Agent of that browser'), {
      target: { value: UA },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save session' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(api.save).toHaveBeenCalledWith('manhuaus', {
      userAgent: UA,
      cookies: [
        expect.objectContaining({
          name: 'cf_clearance',
          value: 'clear-value',
          domain: 'manhuaus.com',
        }),
      ],
    });

    const card = screen.getByRole('region', { name: 'Saved session for ManhuaUS' });
    expect(within(card).getByText('cf_clearance')).toBeInTheDocument();
    expect(within(card).getByText(UA)).toBeInTheDocument();
    expect(within(card).getByText(/expires in 5 hours/)).toBeInTheDocument();
  });

  it('edits the User-Agent alone, keeping the saved cookie', async () => {
    api.get.mockResolvedValue(savedSession);
    api.save.mockResolvedValue({ ...savedSession, userAgent: 'Changed UA' });
    renderManager();

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const agent = screen.getByLabelText('User-Agent of that browser');
    expect(agent).toHaveValue(UA);
    expect(screen.getByLabelText('Cookie')).toHaveAttribute(
      'placeholder',
      'Leave empty to keep the saved cookie (cf_clearance)',
    );
    fireEvent.change(agent, { target: { value: 'Changed UA' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save session' }));

    await screen.findByRole('region', { name: 'Saved session for ManhuaUS' });
    expect(api.save).toHaveBeenCalledWith('manhuaus', { userAgent: 'Changed UA' });
    expect(screen.getByText('Changed UA')).toBeInTheDocument();
  });

  it('cancels an edit without saving', async () => {
    api.get.mockResolvedValue(savedSession);
    renderManager();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('region', { name: 'Saved session for ManhuaUS' })).toBeInTheDocument();
    expect(api.save).not.toHaveBeenCalled();
  });

  it('deletes the session after a confirmation', async () => {
    api.get.mockResolvedValue(savedSession);
    api.clear.mockResolvedValue(null);
    renderManager();

    fireEvent.click(await screen.findByRole('button', { name: 'Delete the session for ManhuaUS' }));
    expect(api.clear).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await screen.findByText('Paste a session from your browser');
    expect(api.clear).toHaveBeenCalledWith('manhuaus');
  });

  it('warns when the saved browser check has expired', async () => {
    api.get.mockResolvedValue({
      ...savedSession,
      cookies: [
        {
          name: 'cf_clearance',
          domain: 'manhuaus.com',
          expires: Math.floor(Date.now() / 1000) - 1,
        },
      ],
    });
    renderManager();

    expect(await screen.findByRole('status')).toHaveTextContent(/saved browser check has expired/i);
  });

  it('refreshes an expired browser check automatically in the desktop app', async () => {
    const openBrowser = vi.fn().mockResolvedValue({
      success: true,
      message: 'Saved',
      data: { saved: true, cookieCount: 1, message: 'Saved the browser session.' },
    });
    Object.defineProperty(window, 'desktop', {
      configurable: true,
      value: { source: { openBrowser } },
    });
    api.get.mockResolvedValue({
      ...savedSession,
      cookies: [
        {
          name: 'cf_clearance',
          domain: 'manhuaus.com',
          expires: Math.floor(Date.now() / 1000) - 1,
        },
      ],
    });
    renderManager();

    await waitFor(() =>
      expect(openBrowser).toHaveBeenCalledWith('manhuaus', { closeWhenPassed: true }),
    );
    expect(screen.queryByRole('button', { name: 'Refresh in browser' })).not.toBeInTheDocument();
  });

  it('waits until an expiring browser check actually expires', async () => {
    const openBrowser = vi.fn().mockResolvedValue({
      success: true,
      message: 'Saved',
      data: { saved: true, cookieCount: 1, message: 'Saved the browser session.' },
    });
    Object.defineProperty(window, 'desktop', {
      configurable: true,
      value: { source: { openBrowser } },
    });
    api.get.mockResolvedValue({
      ...savedSession,
      cookies: [
        {
          name: 'cf_clearance',
          domain: 'manhuaus.com',
          expires: Math.floor(Date.now() / 1000) + 60,
        },
      ],
    });
    renderManager();

    expect(await screen.findByRole('status')).toHaveTextContent(/expires in a few minutes/i);
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it('shows nothing without a session where it was asked to, or when the server refuses', async () => {
    api.get.mockResolvedValue(empty);
    const { container, unmount } = renderManager({ hideWhenEmpty: true });
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    unmount();

    api.get.mockRejectedValue(new Error('This action is only available from the server host'));
    const refused = renderManager();
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    expect(refused.container).toBeEmptyDOMElement();
  });
});
