import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/library-store', () => ({
  useMangaLibrary: () => ({
    manga: [{ source: 'mangageko' }, { source: 'asura' }, { source: 'removed-source' }],
    loading: false,
  }),
  useSources: () => ({
    sources: [
      { id: 'mangageko', name: 'MangaGeko' },
      { id: 'asura', name: 'Asura Scans' },
    ],
    loading: false,
  }),
}));
vi.mock('@/components/settings/account-panel', () => ({
  AccountPanel: () => <h2>Profile panel</h2>,
}));
vi.mock('@/components/settings/appearance-panel', () => ({ AppearancePanel: () => null }));
vi.mock('@/components/settings/extensions-panel', () => ({ ExtensionsPanel: () => null }));
vi.mock('@/components/settings/statistics-panel', () => ({ StatisticsPanel: () => null }));
vi.mock('@/components/settings/notifications-panel', () => ({ NotificationsPanel: () => null }));
vi.mock('@/components/settings/sync-panel', () => ({ SyncPanel: () => null }));
vi.mock('@/components/settings/shortcuts-panel', () => ({ ShortcutsPanel: () => null }));
vi.mock('@/components/settings/privacy-panel', () => ({ PrivacyPanel: () => null }));
vi.mock('@/components/settings/about-panel', () => ({ AboutPanel: () => <h2>About panel</h2> }));
vi.mock('@/components/settings/changelog-panel', () => ({ ChangelogPanel: () => null }));
vi.mock('@/components/settings/library-panel', () => ({ LibraryPanel: () => null }));

import { SettingsPageClient } from '@/app/settings/client';
import { ReaderPanel } from '@/components/settings/reader-panel';

const highlighted = () =>
  within(screen.getByRole('navigation', { name: 'Settings sections' })).getByRole('button', {
    current: 'page',
  });

afterEach(() => {
  window.history.replaceState(null, '', '/');
  delete (window as Window & { navigation?: EventTarget }).navigation;
});

describe('Settings deep links', () => {
  it('highlights the section a #hash link opens, not Profile', async () => {
    window.history.replaceState(null, '', '/settings#about');
    render(<SettingsPageClient />);

    await waitFor(() => expect(highlighted()).toHaveTextContent('About'));
    expect(screen.getByRole('heading', { name: 'About panel' })).toBeInTheDocument();
  });

  it('follows an in-app link to another section on the same page', async () => {
    // jsdom has no Navigation API; this stands in for Chromium's, which reports the
    // pushState the Next router uses for a hash-only navigation (no hashchange fires).
    const navigation = new EventTarget();
    (window as Window & { navigation?: EventTarget }).navigation = navigation;
    window.history.replaceState(null, '', '/settings');
    render(<SettingsPageClient />);
    expect(highlighted()).toHaveTextContent('Profile');

    act(() => {
      window.history.pushState(null, '', '/settings#about');
      navigation.dispatchEvent(new Event('currententrychange'));
    });

    expect(highlighted()).toHaveTextContent('About');
    expect(screen.getByRole('heading', { name: 'About panel' })).toBeInTheDocument();
  });
});

describe('Per-source reading direction', () => {
  it('lists sources by their installed name, keeping the id for an unknown one', async () => {
    render(<ReaderPanel />);

    // Nothing chosen yet, so the menu shows the first source — by name.
    await userEvent.click(screen.getByRole('button', { name: /Asura Scans/ }));

    const options = screen.getAllByRole('menuitem').map((option) => option.textContent?.trim());
    expect(options).toEqual(['Asura Scans', 'MangaGeko', 'removed-source']);
    expect(options).not.toContain('mangageko');
  });
});
