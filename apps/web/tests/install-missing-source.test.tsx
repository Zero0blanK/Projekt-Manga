import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CatalogEntry } from '@/lib/extensions-store';

// The import dialog's Install button for a backup source that isn't installed here.

const mocks = vi.hoisted(() => ({
  install: vi.fn(),
  change: vi.fn(),
  entries: [] as CatalogEntry[],
  engineList: [] as unknown[],
}));

vi.mock('@/lib/extensions-store', () => ({
  useSourceCatalog: () => ({
    entries: mocks.entries,
    repositories: [
      {
        id: 'repo-z',
        name: 'Projekt Manga sources',
        url: 'https://raw.githubusercontent.com/Zero0blanK/sources/main/index.json',
      },
    ],
  }),
  extensionActions: { install: mocks.install },
}));
vi.mock('@/lib/engine-extensions', () => ({
  ENGINE_AUTHOR: '@KEI',
  useSuwayomiExtensions: () => ({ enabled: true, list: { data: mocks.engineList } }),
  useEngineExtensionActions: () => ({ change: mocks.change, busy: new Set() }),
}));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));

const { InstallMissingSource } = await import('@/components/settings/install-missing-source');

const entry = (name: string, lang: string): CatalogEntry => ({
  repositoryId: 'repo-z',
  repositoryName: 'Projekt Manga sources',
  entry: {
    source_key: name.toLowerCase(),
    name,
    lang,
    version: '1.0.0',
    base_url: 'https://example.com',
    entry_url: 'https://example.com/source.js',
    allowed_hosts: ['example.com'],
    isNSFW: false,
  },
  installedId: null,
  conflictsWithInstalled: false,
  updateAvailable: false,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.entries = [entry('Gamma', 'en')];
  mocks.engineList = [
    {
      pkg_name: 'ext.all.delta',
      name: 'Delta',
      lang: 'all',
      version: '1.4.0',
      icon_url: null,
      is_nsfw: false,
      installed: false,
      has_update: false,
      obsolete: false,
    },
  ];
});
afterEach(cleanup);

describe('installing a missing source from the import', () => {
  it("installs a repository's source of that name, then matches again", async () => {
    const user = userEvent.setup();
    const onInstalled = vi.fn(async () => undefined);
    mocks.install.mockResolvedValue(undefined);
    render(<InstallMissingSource name="Gamma (EN)" onInstalled={onInstalled} />);

    await user.click(screen.getByRole('button', { name: 'Install Gamma from @Zero0blanK' }));
    await waitFor(() => expect(onInstalled).toHaveBeenCalledTimes(1));
    expect(mocks.install).toHaveBeenCalledWith('repo-z', 'gamma', expect.any(Function));
  });

  it('installs an engine extension of that name when no repository has one', async () => {
    const user = userEvent.setup();
    const onInstalled = vi.fn(async () => undefined);
    mocks.change.mockResolvedValue(undefined);
    render(<InstallMissingSource name="Delta" onInstalled={onInstalled} />);

    expect(screen.getByRole('button')).toHaveTextContent('Install from @KEI');
    await user.click(screen.getByRole('button'));
    await waitFor(() => expect(onInstalled).toHaveBeenCalledTimes(1));
    expect(mocks.change).toHaveBeenCalledWith(
      expect.objectContaining({ pkg_name: 'ext.all.delta' }),
      'install',
    );
  });

  it('offers nothing when no source of that name can be installed', () => {
    const { container } = render(
      <InstallMissingSource name="Nowhere" onInstalled={vi.fn(async () => undefined)} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
