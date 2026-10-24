import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InstalledSourceCard } from '@/components/discover/installed-source-card';
import {
  normalizeSourceLanguage,
  repairSourceName,
  sourceLanguageEditions,
  sourceLanguageGroup,
} from '@/lib/source-language';
import type { CatalogEntry } from '@/lib/extensions-store';

const mocks = vi.hoisted(() => ({ install: vi.fn(), toast: vi.fn() }));
vi.mock('@/lib/source-health-status', () => ({ useSourceHealthStatus: () => 'ok' }));
vi.mock('@/lib/extensions-store', () => ({ extensionActions: { install: mocks.install } }));
vi.mock('@/hooks/use-toast', () => ({ toast: mocks.toast }));
vi.mock('@/lib/library-store', () => ({
  useSourceCapabilities: () => ({ capabilities: { latest: true, languageFilter: false } }),
  useSourceFilters: () => ({ filters: [] }),
}));
vi.mock('@/lib/source-display-language', () => ({
  useSourceDisplayLanguage: () => ['all', vi.fn()],
  sourceLanguageFilter: () => null,
}));
function edition(key: string, lang: string, repositoryId = 'repo'): CatalogEntry {
  return {
    repositoryId,
    repositoryName: repositoryId,
    installedId: key === 'mangadex' ? 'installed' : null,
    conflictsWithInstalled: false,
    updateAvailable: false,
    entry: {
      source_key: key,
      family_key: 'mangadex',
      name: `MangaDex — ${lang}`,
      lang,
      version: '1.0.0',
      entry_url: 'https://example.com/source.js',
      base_url: 'https://example.com',
      allowed_hosts: ['example.com'],
      isNSFW: false,
    },
  };
}
const entries = [edition('mangadex', 'en'), edition('mangadex-ja', 'ja')];
function card(items = entries) {
  render(
    <InstalledSourceCard
      source={{ id: 'mangadex', name: 'MangaDex', lang: 'en', isNSFW: false, accent: '#123456' }}
      editionEntries={items}
      pinned={false}
      privateReading={false}
      onTogglePin={vi.fn()}
      onToggleIncognito={vi.fn()}
      canMoveUp={false}
      canMoveDown={false}
      onMovePin={vi.fn()}
    />,
  );
}
async function languages() {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Options for MangaDex' }));
  await user.hover(screen.getByRole('menuitem', { name: 'Display languages' }));
  await screen.findByRole('menuitemradio', { name: /Japanese/ });
  return user;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.install.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe('source language editions', () => {
  it('normalizes language aliases and repairs known corrupt source names', () => {
    expect(normalizeSourceLanguage('jp')).toBe('ja');
    expect(sourceLanguageGroup('en_US')).toBe('en');
    expect(repairSourceName('MangaDex â€” EspaÃ±ol')).toBe('MangaDex — Español');
  });
  it('keeps language families inside their repository', () => {
    const other = edition('mangadex-fr', 'fr', 'other');
    expect(sourceLanguageEditions('mangadex', 'repo', [...entries, other])).toEqual(entries);
  });
  it('installs an edition while retaining the current card and browse links', async () => {
    let finish!: () => void;
    mocks.install.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    card();
    await languages();
    expect(screen.getByRole('menuitemradio', { name: /English/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Japanese/ }));
    expect(mocks.install).toHaveBeenCalledExactlyOnceWith('repo', 'mangadex-ja', expect.any(Function));
    expect(screen.getByRole('status')).toHaveTextContent('Installing language edition');
    await act(async () => finish());
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'Popular' })).toHaveAttribute(
      'href',
      '/discover/popular?source=mangadex',
    );
    expect(mocks.toast).toHaveBeenCalledWith({ description: 'MangaDex — ja installed.' });
  });
  it('reports install failures and allows a retry', async () => {
    mocks.install.mockRejectedValueOnce(new Error('Repository unavailable'));
    card();
    await languages();
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Japanese/ }));
    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith({
        variant: 'destructive',
        description: 'Repository unavailable',
      }),
    );
    await languages();
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Japanese/ }));
    expect(mocks.install).toHaveBeenCalledTimes(2);
    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith({ description: 'MangaDex — ja installed.' }),
    );
  });
  it('does not reinstall an already installed edition', async () => {
    card([entries[0], { ...entries[1], installedId: 'ja-installed' }]);
    await languages();
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Japanese/ }));
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith({ description: 'Japanese is already installed.' });
  });
});
