import { fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogEntry } from '@/lib/extensions-store';
import { SourceCatalog } from '@/components/discover/source-catalog';
import { emptySourceFilters } from '@/components/discover/source-filters';

const mocks = vi.hoisted(() => ({
  entries: [] as CatalogEntry[],
  loading: false,
  hideAdult: false,
  install: vi.fn(),
  uninstall: vi.fn(),
  update: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('@/lib/extensions-store', () => ({
  useSourceCatalog: () => ({
    entries: mocks.entries,
    loading: mocks.loading,
    hasNoRepositories: false,
    repositories: [
      { id: 'repo-a', name: 'First repository', sources: [] },
      { id: 'repo-b', name: 'Second repository', sources: [] },
      { id: 'offline', name: 'Offline repository', fetchError: 'Network unavailable', sources: [] },
    ],
  }),
  extensionActions: {
    install: mocks.install,
    uninstall: mocks.uninstall,
    checkForUpdate: mocks.update,
    refreshRepository: mocks.refresh,
  },
}));
vi.mock('@/components/discover/content-privacy', () => ({
  useContentPrivacy: () => [{ hideAdult: mocks.hideAdult }],
  isAdultSource: (rating: string) => rating === 'nsfw',
}));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));

function entry(key: string, name: string, lang: string, repositoryId = 'repo-a'): CatalogEntry {
  return {
    repositoryId,
    repositoryName: repositoryId,
    entry: {
      source_key: key,
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
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loading = false;
  mocks.hideAdult = false;
  mocks.entries = [
    entry('english', 'English source', 'en'),
    entry('us', 'US source', 'en-US'),
    entry('japanese', 'Japanese source', 'jp'),
    entry('brazil', 'Brazil source', 'pt-br'),
    entry('multi', 'Many languages', 'all'),
  ];
});

describe('Extension catalogue language sections', () => {
  it('groups regional languages and shows readable regional labels', () => {
    render(<SourceCatalog />);
    expect(screen.getByRole('tab', { name: 'All 5' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'English 2' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Japanese 1' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Multilingual 1' })).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'English sources' })).getAllByRole('listitem'),
    ).toHaveLength(2);
    expect(screen.getByText('v1.0.0 · Brazilian Portuguese')).toBeInTheDocument();
    expect(screen.getByText('v1.0.0 · Japanese')).toBeInTheDocument();
  });

  it('filters via accessible tabs and supports keyboard navigation', async () => {
    const user = userEvent.setup();
    render(<SourceCatalog />);
    await user.click(screen.getByRole('tab', { name: 'Japanese 1' }));
    expect(screen.getByText('Japanese source')).toBeVisible();
    expect(screen.queryByText('English source')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('1 catalogue results');
    await user.keyboard('{Home}');
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'All 5' })).toHaveAttribute('aria-selected', 'true'),
    );
    expect(screen.getByText('English source')).toBeVisible();
  });

  it('combines name, privacy and installed filters before counting tabs', () => {
    const adult = entry('adult', 'English adult', 'en');
    adult.entry.content_rating = 'nsfw';
    adult.entry.isNSFW = true;
    mocks.entries.push(adult);
    mocks.entries[0].installedId = 'installed';
    mocks.hideAdult = true;
    const { rerender } = render(
      <SourceCatalog filters={{ ...emptySourceFilters, name: 'English' }} />,
    );
    expect(screen.getByRole('tab', { name: 'All 1' })).toBeInTheDocument();
    expect(screen.queryByText('English adult')).not.toBeInTheDocument();
    rerender(<SourceCatalog filters={{ ...emptySourceFilters, status: 'installed' }} />);
    expect(screen.getByRole('tab', { name: 'English 1' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /Japanese/ })).not.toBeInTheDocument();
  });

  it('keeps repositories with matching keys separate and preserves actions and conflicts', async () => {
    const duplicate = entry('english', 'Other English', 'en', 'repo-b');
    duplicate.conflictsWithInstalled = true;
    mocks.entries.push(duplicate);
    mocks.entries[0].installedId = 'installed';
    mocks.entries[0].updateAvailable = true;
    render(<SourceCatalog />);
    const updates = screen.getByRole('region', { name: 'Updates extensions' });
    const available = screen.getByRole('region', { name: 'Available extensions' });
    expect(within(updates).getAllByRole('listitem')).toHaveLength(1);
    expect(
      within(within(available).getByText('Other English').closest('li')!).getByRole('button', {
        name: 'Install Other English',
      }),
    ).toBeDisabled();
    fireEvent.click(within(updates).getByRole('button', { name: /^Update / }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith('installed'));
    fireEvent.click(
      within(within(available).getByText('US source').closest('li')!).getByRole('button', {
        name: 'Install US source',
      }),
    );
    await waitFor(() => expect(mocks.install).toHaveBeenCalledWith('repo-a', 'us', expect.any(Function)));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Offline repository' }));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledWith('offline'));
  });

  it('separates updates, installed and available sources without duplicate rows and moves updated entries', () => {
    mocks.entries[0].installedId = 'update-id';
    mocks.entries[0].updateAvailable = true;
    mocks.entries[2].installedId = 'installed-id';
    const { rerender } = render(<SourceCatalog />);
    const updates = screen.getByRole('region', { name: 'Updates extensions' });
    const installed = screen.getByRole('region', { name: 'Installed extensions' });
    const available = screen.getByRole('region', { name: 'Available extensions' });
    expect(within(updates).getByText('English source')).toBeInTheDocument();
    expect(within(installed).getByText('Japanese source')).toBeInTheDocument();
    expect(within(available).queryByText('English source')).not.toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
    for (const section of [updates, installed, available]) {
      expect(section.querySelector('h3 svg')).toHaveAttribute('aria-hidden', 'true');
    }
    mocks.entries[0].updateAvailable = false;
    rerender(<SourceCatalog />);
    expect(screen.queryByRole('region', { name: 'Updates extensions' })).not.toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'Installed extensions' })).getByText(
        'English source',
      ),
    ).toBeInTheDocument();
  });

  it('keeps repository failures visible when no sources match without showing a false empty state while loading', () => {
    mocks.loading = true;
    const { rerender } = render(<SourceCatalog />);
    expect(screen.queryByText('No sources match the current filters.')).not.toBeInTheDocument();
    mocks.loading = false;
    rerender(<SourceCatalog filters={{ ...emptySourceFilters, name: 'nothing matches' }} />);
    expect(screen.getByRole('tab', { name: 'All 0' })).toBeInTheDocument();
    expect(screen.getByText('No sources match the current filters.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh Offline repository' })).toBeInTheDocument();
  });

  it('repairs the known cached MangaDex name encoding', () => {
    mocks.entries = [entry('mangadex', 'MangaDex â€” English', 'en')];
    render(<SourceCatalog />);
    expect(screen.getByText('MangaDex — English')).toBeInTheDocument();
    expect(screen.queryByText(/â€/)).not.toBeInTheDocument();
  });
});
