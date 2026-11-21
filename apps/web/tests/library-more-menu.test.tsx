import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Manga } from '@/lib/manga-data';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

const { LibraryMoreMenu } = await import('@/components/library/library-more-menu');

const title = (id: string) => ({ id }) as Manga;

describe('the library More menu', () => {
  it('gathers the library pages that are not list controls', async () => {
    const user = userEvent.setup();
    render(<LibraryMoreMenu library={[title('a'), title('b')]} />);
    await user.click(screen.getByRole('button', { name: 'More library pages' }));
    const links = Object.fromEntries(
      (await screen.findAllByRole('menuitem'))
        .filter((item) => item.getAttribute('href'))
        .map((item) => [item.textContent?.trim(), item.getAttribute('href')]),
    );
    expect(links).toEqual({
      Bookmarks: '/bookmarks',
      'Upcoming releases': '/upcoming',
      'Year in manga': '/year',
      'Local comics': '/local',
      'Migrate a source': '/migrate',
    });
    await user.click(screen.getByRole('menuitem', { name: 'Random title' }));
    expect(push).toHaveBeenCalledWith(expect.stringMatching(/^\/manga\/(a|b)$/));
  });

  it('leaves out what needs titles when the library is empty', async () => {
    const user = userEvent.setup();
    render(<LibraryMoreMenu library={[]} />);
    await user.click(screen.getByRole('button', { name: 'More library pages' }));
    await screen.findByRole('menuitem', { name: 'Bookmarks' });
    expect(screen.queryByRole('menuitem', { name: 'Upcoming releases' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Migrate a source' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Random title' })).toBeNull();
  });
});
