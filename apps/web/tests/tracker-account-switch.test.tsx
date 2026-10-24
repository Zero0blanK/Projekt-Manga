import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { TrackerLinkButton } from '@/components/manga-detail/tracker-link-button';
import type { Manga } from '@/lib/manga-data';

let currentUser = { id: 'account-a' };
const getConnectedTrackers = vi.fn().mockResolvedValue([{ tracker: 'ANILIST' }]);
const getMangaTrackerLinks = vi
  .fn()
  .mockImplementation(() =>
    Promise.resolve(currentUser.id === 'account-a' ? [{ tracker: 'ANILIST', id: 'link-a' }] : []),
  );

vi.mock('@/lib/session-resource', () => ({ useCurrentUser: () => ({ user: currentUser }) }));
vi.mock('@projekt-manga/api-client', () => ({
  ApiError: class extends Error {},
  getConnectedTrackers: (...args: unknown[]) => getConnectedTrackers(...args),
  getMangaTrackerLinks: (...args: unknown[]) => getMangaTrackerLinks(...args),
}));

describe('tracker link account isolation', () => {
  it('labels the tracker link control and restores focus after closing its dialog', async () => {
    const user = userEvent.setup();
    currentUser = { id: 'account-b' };
    const manga = { id: 'manga-1', title: 'Title' } as Manga;
    render(<TrackerLinkButton manga={manga} />);

    const trigger = await screen.findByRole('button', { name: 'Link to AniList' });
    expect(trigger.getAttribute('aria-pressed')).toBe('false');
    await user.click(trigger);
    expect(await screen.findByRole('dialog', { name: 'AniList' })).toBeVisible();
    expect(screen.getByText('Link Title to sync reading progress.')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Close dialog' }));
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('does not show a previous account link while the next account loads', async () => {
    currentUser = { id: 'account-a' };
    const manga = { id: 'manga-1', title: 'Title' } as Manga;
    const view = render(<TrackerLinkButton manga={manga} />);
    await screen.findByRole('button', { name: 'Linked to AniList' });

    currentUser = { id: 'account-b' };
    view.rerender(<TrackerLinkButton manga={manga} />);
    expect(screen.queryByRole('button', { name: 'Linked to AniList' })).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Link to AniList' })).toBeInTheDocument(),
    );
  });
});
