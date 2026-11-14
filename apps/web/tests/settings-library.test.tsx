import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/library-store', () => ({
  useMangaLibrary: () => ({
    manga: [
      { id: '1', source: 'mangadex' },
      { id: '2', source: 'weebcentral' },
      { id: '3', source: 'mangadex' },
    ],
  }),
  useSources: () => ({
    sources: [
      { id: 'mangadex', name: 'MangaDex' },
      { id: 'weebcentral', name: 'Weeb Central' },
    ],
  }),
}));
// The Update Library rules have tests of their own (sync-panel.test.tsx).
vi.mock('@/components/settings/sync-panel', () => ({ SyncPanel: () => null }));

const { actions, getSetting } = await import('@/lib/app-store');
const { LibraryPanel } = await import('@/components/settings/library-panel');
const { SourceAlerts } = await import('@/components/settings/source-alerts');
const { SHOW_RECENTLY_UPDATED } = await import('@/lib/library-layout');

afterEach(() => {
  cleanup();
  actions.setSetting('notifySource:weebcentral', true);
  actions.setSetting(SHOW_RECENTLY_UPDATED, false);
});

describe('Settings › Library', () => {
  it('keeps Recently Updated off until it is turned on', async () => {
    render(<LibraryPanel />);
    const toggle = screen.getByRole('switch', { name: 'Show Recently Updated' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(toggle);
    expect(getSetting(SHOW_RECENTLY_UPDATED, false)).toBe(true);
  });

  it('sums up source alerts here and lists each source in a dialog', async () => {
    actions.setSetting('notifySource:weebcentral', false);
    render(<SourceAlerts />);
    expect(screen.getByText('1 of 2 sources alert')).toBeInTheDocument();
    // Nothing per source on the page itself.
    expect(screen.queryByText('MangaDex')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Choose per source' }));
    const dialog = screen.getByRole('dialog', { name: 'Source alerts and cadence' });
    expect(within(dialog).getByRole('switch', { name: 'MangaDex' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(within(dialog).getByRole('switch', { name: 'Weeb Central' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });
});
