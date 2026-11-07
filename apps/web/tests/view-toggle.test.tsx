import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ViewToggle } from '@/components/library/view-toggle';
import { actions } from '@/lib/app-store';

afterEach(() => {
  cleanup();
  actions.resetAll();
});

describe('library view button', () => {
  it('is one button naming the current layout, with the rest in its menu', async () => {
    const user = userEvent.setup();
    actions.setView('grid');
    render(<ViewToggle />);

    expect(screen.getAllByRole('button')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Library view: Grid' }));
    expect((await screen.findAllByRole('menuitem')).map((item) => item.textContent)).toEqual([
      'Grid',
      'Compact',
      'List',
    ]);

    await user.click(screen.getByRole('menuitem', { name: 'List' }));
    expect(await screen.findByRole('button', { name: 'Library view: List' })).toBeInTheDocument();
  });
});
