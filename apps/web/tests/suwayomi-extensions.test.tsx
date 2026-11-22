import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CatalogEntry } from '@/lib/extensions-store';

// Discover › Extensions lists the extension engine's extensions in the same sections as the
// repositories' sources, each row credited to its author.

const getSuwayomiSettings = vi.fn();
const getSuwayomiExtensions = vi.fn();
const changeSuwayomiExtension = vi.fn();
const mocks = vi.hoisted(() => ({ entries: [] as CatalogEntry[] }));

vi.mock('@projekt-manga/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@projekt-manga/api-client')>()),
  getSuwayomiSettings: (...args: unknown[]) => getSuwayomiSettings(...args),
  getSuwayomiExtensions: (...args: unknown[]) => getSuwayomiExtensions(...args),
  changeSuwayomiExtension: (...args: unknown[]) => changeSuwayomiExtension(...args),
}));
vi.mock('@/lib/extensions-store', () => ({
  useSourceCatalog: () => ({
    entries: mocks.entries,
    loading: false,
    hasNoRepositories: mocks.entries.length === 0,
    repositories: [
      {
        id: 'repo-z',
        name: 'Projekt Manga sources',
        url: 'https://raw.githubusercontent.com/Zero0blanK/sources/main/index.json',
        sources: [],
      },
    ],
  }),
  extensionActions: {
    install: vi.fn(),
    uninstall: vi.fn(),
    checkForUpdate: vi.fn(),
    refreshRepository: vi.fn(),
  },
}));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));
vi.mock('@/components/discover/content-privacy', () => ({
  useContentPrivacy: () => [{ hideAdult: true }],
  isAdultSource: (rating: string) => rating === 'nsfw',
}));

const { SourceCatalog } = await import('@/components/discover/source-catalog');
const { emptySourceFilters } = await import('@/components/discover/source-filters');
const { queryClient } = await import('@/lib/query-client');

const extension = (name: string, lang: string, extra: Record<string, unknown> = {}) => ({
  pkg_name: `ext.${lang}.${name.toLowerCase()}`,
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

function repositorySource(name: string, lang: string): CatalogEntry {
  return {
    repositoryId: 'repo-z',
    repositoryName: 'Projekt Manga sources',
    entry: {
      source_key: name.toLowerCase(),
      name,
      lang,
      version: '2.0.0',
      base_url: 'https://example.com',
      entry_url: 'https://example.com/source.js',
      allowed_hosts: ['example.com'],
      isNSFW: false,
    },
    installedId: null,
    conflictsWithInstalled: false,
    updateAvailable: false,
  };
}

const catalog = (props: Partial<Parameters<typeof SourceCatalog>[0]> = {}) =>
  render(<SourceCatalog filters={emptySourceFilters} showEngine {...props} />);

describe('Extension engine extensions in Discover', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryClient.clear();
    mocks.entries = [repositorySource('Gamma', 'en')];
    getSuwayomiSettings.mockResolvedValue({
      mode: 'built-in',
      enabled: true,
      url: '',
      username: null,
      has_password: false,
      password_readable: true,
    });
    getSuwayomiExtensions.mockResolvedValue([
      extension('Alpha', 'en', { installed: true, has_update: true }),
      extension('Beta', 'en'),
      extension('Hidden', 'en', { is_nsfw: true }),
    ]);
  });
  afterEach(cleanup);

  it('lists both kinds in the same sections and languages, each by its author', async () => {
    catalog();
    const updates = await screen.findByRole('region', { name: 'Updates extensions' });
    expect(within(updates).getByText('Alpha')).toBeInTheDocument();

    // One English list in Available, holding the repository's source and the engine's.
    const available = screen.getByRole('region', { name: 'Available extensions' });
    const english = within(available).getByRole('region', { name: 'English sources' });
    const rows = within(english).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Beta'),
      expect.stringContaining('Gamma'),
    ]);
    expect(rows[0]).toHaveTextContent('@KEI');
    expect(rows[1]).toHaveTextContent('@Zero0blanK');
    expect(screen.queryByText('Suwayomi')).toBeNull();
    expect(screen.queryByText('Hidden')).toBeNull();
  });

  it("follows the page's language and rating filters", async () => {
    getSuwayomiExtensions.mockResolvedValue([extension('Alpha', 'en'), extension('Nihon', 'ja')]);
    catalog({ language: 'ja', filters: { ...emptySourceFilters, rating: 'safe' } });
    expect(await screen.findByText('Nihon')).toBeInTheDocument();
    expect(screen.queryByText('Alpha')).toBeNull();
    expect(screen.queryByText('Gamma')).toBeNull();
  });

  it('shows only the engine when the filter picks it, and only a repository when it picks one', async () => {
    const engineOnly = catalog({ showRepositories: false });
    expect(await screen.findByText('Beta')).toBeInTheDocument();
    expect(screen.queryByText('Gamma')).toBeNull();
    engineOnly.unmount();

    catalog({ repositoryId: 'repo-z', showEngine: false });
    expect(screen.getByText('Gamma')).toBeInTheDocument();
    expect(screen.queryByText('Beta')).toBeNull();
    expect(getSuwayomiSettings).toHaveBeenCalledTimes(1);
  });

  it('installs an engine extension in the engine and refreshes the installed sources', async () => {
    const user = userEvent.setup();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    changeSuwayomiExtension.mockResolvedValue(extension('Beta', 'en', { installed: true }));
    catalog();
    await user.click(await screen.findByRole('button', { name: 'Install Beta' }));
    await waitFor(() =>
      expect(changeSuwayomiExtension).toHaveBeenCalledWith('ext.en.beta', 'install'),
    );
    const installed = await screen.findByRole('region', { name: 'Installed extensions' });
    expect(within(installed).getByText('Beta')).toBeInTheDocument();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['sources'] });
  });

  it('lists only the repositories for a reader who may not manage the engine', async () => {
    getSuwayomiSettings.mockRejectedValue(new Error('Forbidden'));
    catalog();
    await waitFor(() => expect(getSuwayomiSettings).toHaveBeenCalled());
    expect(screen.getByText('Gamma')).toBeInTheDocument();
    expect(getSuwayomiExtensions).not.toHaveBeenCalled();
  });

  it('points to the extension engine settings when the built-in engine is not running', async () => {
    getSuwayomiExtensions.mockRejectedValue(new Error("The extension engine isn't running"));
    catalog();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't reach the extension engine.");
    expect(
      within(alert).getByRole('link', { name: /Settings › Extensions › Extension engine/ }),
    ).toHaveAttribute('href', '/settings#extensions');
    // The repositories' sources still show.
    expect(screen.getByText('Gamma')).toBeInTheDocument();
  });
});
