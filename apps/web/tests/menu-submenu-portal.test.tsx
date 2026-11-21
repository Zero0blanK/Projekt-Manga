import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

describe('a dropdown submenu', () => {
  // Inside its parent menu it was clipped to a sliver: the parent hides overflow and, in
  // the Frost and Ink styles, positions it (backdrop blur, open animation).
  it('renders outside its parent menu, so the parent cannot clip it', async () => {
    const user = userEvent.setup();
    render(
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger>Options</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Display languages</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem>English</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    await user.click(screen.getByRole('button', { name: 'Options' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Display languages' }));
    const english = await screen.findByRole('menuitem', { name: 'English' });
    const [parent, sub] = screen.getAllByRole('menu');
    expect(sub).toContainElement(english);
    expect(parent.contains(sub)).toBe(false);
  });
});
