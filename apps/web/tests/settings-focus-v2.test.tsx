import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/components/settings/account-panel', () => ({ AccountPanel: () => null }));
vi.mock('@/components/settings/appearance-panel', () => ({
  AppearancePanel: () => (
    <div>
      <div>Theme</div>
      <select aria-label="Theme choice">
        <option>Dark</option>
      </select>
    </div>
  ),
}));
vi.mock('@/components/settings/reader-panel', () => ({ ReaderPanel: () => null }));
vi.mock('@/components/settings/extensions-panel', () => ({ ExtensionsPanel: () => null }));
vi.mock('@/components/settings/statistics-panel', () => ({ StatisticsPanel: () => null }));
vi.mock('@/components/settings/notifications-panel', () => ({ NotificationsPanel: () => null }));
vi.mock('@/components/settings/sync-panel', () => ({
  SyncPanel: () => (
    <div aria-disabled="true">
      <div>Storage limit</div>
      <input disabled aria-label="Unavailable quota" />
    </div>
  ),
}));
vi.mock('@/components/settings/shortcuts-panel', () => ({ ShortcutsPanel: () => null }));
vi.mock('@/components/settings/privacy-panel', () => ({ PrivacyPanel: () => null }));
vi.mock('@/components/settings/about-panel', () => ({ AboutPanel: () => null }));
vi.mock('@/components/settings/changelog-panel', () => ({ ChangelogPanel: () => null }));
import { SettingsPageClient } from '@/app/settings/client';
afterEach(() => window.history.replaceState(null, '', '/'));

/** What the navbar's settings search sends when a result is chosen (floating-nav.tsx). */
function chooseSetting(section: string, label: string) {
  act(() => {
    window.dispatchEvent(new CustomEvent('projekt-manga:setting', { detail: { section, label } }));
  });
}

describe('Settings search focus integration', () => {
  it('opens the destination panel and focuses the actual matching control', async () => {
    render(<SettingsPageClient />);
    chooseSetting('appearance', 'Theme');
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Theme choice' })).toHaveFocus(),
    );
    expect(window.location.hash).toBe('#appearance');
    expect(screen.getByRole('status')).toHaveTextContent('Opened Theme.');
  });
  it('focuses the explanation of an unavailable setting without enabling its control', async () => {
    render(<SettingsPageClient />);
    chooseSetting('sync', 'Storage limit');
    await waitFor(() => expect(screen.getByText('Storage limit')).toHaveFocus());
    expect(screen.getByRole('textbox', { name: 'Unavailable quota' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Storage limit is currently unavailable.');
  });
});
