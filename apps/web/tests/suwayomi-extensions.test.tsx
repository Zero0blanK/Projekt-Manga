import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const getSuwayomiSettings = vi.fn();
const getSuwayomiExtensions = vi.fn();
const changeSuwayomiExtension = vi.fn();

vi.mock('@projekt-manga/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@projekt-manga/api-client')>()),
  getSuwayomiSettings: (...args: unknown[]) => getSuwayomiSettings(...args),
  getSuwayomiExtensions: (...args: unknown[]) => getSuwayomiExtensions(...args),
  changeSuwayomiExtension: (...args: unknown[]) => changeSuwayomiExtension(...args),
}));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));
vi.mock('@/components/discover/content-privacy', () => ({
  useContentPrivacy: () => [{ hideAdult: true }],
}));

const { SuwayomiExtensions } = await import('@/components/discover/suwayomi-extensions');
const { queryClient } = await import('@/lib/query-client');

const extension = (name: string, lang: string, extra: Record<string, unknown> = {}) => ({
  pkg_name: `eu.kanade.tachiyomi.extension.${lang}.${name.toLowerCase()}`,
  name,
  lang,
  version: '1.4.0',
  icon_url: null,
  is_nsfw: false,
  installed: false,
  has_update: false,
  obsolete: false,
  ...extra,
});

describe('Suwayomi extensions in Discover', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryClient.clear();
    getSuwayomiSettings.mockResolvedValue({
      enabled: true,
      url: 'http://127.0.0.1:4567',
      username: null,
      has_password: false,
      password_readable: true,
    });
    getSuwayomiExtensions.mockResolvedValue([
      extension('Alpha', 'en', { installed: true, has_update: true }),
      extension('Beta', 'ja'),
      extension('Hidden', 'en', { is_nsfw: true }),
    ]);
  });
  afterEach(cleanup);

  it('lists every extension the server can install, by status, hiding adult ones as set', async () => {
    render(<SuwayomiExtensions name="" filters={{ language: '', rating: '' }} />);
    const updates = await screen.findByRole('region', { name: 'Suwayomi updates' });
    expect(within(updates).getByText('Alpha')).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'Suwayomi available' })).getByText('Beta'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Hidden')).toBeNull();
  });

  it("follows the page's language and rating filters", async () => {
    render(<SuwayomiExtensions name="" filters={{ language: 'ja', rating: 'safe' }} />);
    expect(await screen.findByText('Beta')).toBeInTheDocument();
    expect(screen.queryByText('Alpha')).toBeNull();
  });

  it('installs on the server and refreshes the installed sources', async () => {
    const user = userEvent.setup();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    changeSuwayomiExtension.mockResolvedValue(extension('Beta', 'ja', { installed: true }));
    render(<SuwayomiExtensions name="" filters={{ language: '', rating: '' }} />);
    const available = await screen.findByRole('region', { name: 'Suwayomi available' });
    await user.click(within(available).getByRole('button', { name: 'Install' }));
    await waitFor(() =>
      expect(changeSuwayomiExtension).toHaveBeenCalledWith(
        'eu.kanade.tachiyomi.extension.ja.beta',
        'install',
      ),
    );
    await screen.findByRole('region', { name: 'Suwayomi installed' });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['sources'] });
  });

  it('shows nothing without a connected server, or for a reader who may not manage it', async () => {
    getSuwayomiSettings.mockRejectedValue(new Error('Forbidden'));
    const { container } = render(
      <SuwayomiExtensions name="" filters={{ language: '', rating: '' }} />,
    );
    await waitFor(() => expect(getSuwayomiSettings).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    expect(getSuwayomiExtensions).not.toHaveBeenCalled();
  });
});
