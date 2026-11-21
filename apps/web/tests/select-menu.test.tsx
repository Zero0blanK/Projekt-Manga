import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SelectMenu } from '@/components/ui/select-menu';

const options = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
];

describe('SelectMenu', () => {
  it('names itself with its current choice and reports a new one', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<SelectMenu label="Letter" value="a" options={options} onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: 'Letter: Alpha' }));
    expect(await screen.findByRole('menuitem', { name: 'Alpha' })).toHaveAttribute(
      'aria-current',
      'true',
    );
    await user.click(screen.getByRole('menuitem', { name: 'Beta' }));
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('opens level with its button and at least as wide, whatever width the button has', async () => {
    const user = userEvent.setup();
    render(
      <SelectMenu label="Wide" value="a" options={options} onChange={vi.fn()} className="w-full" />,
    );
    await user.click(screen.getByRole('button', { name: 'Wide: Alpha' }));
    const menu = await screen.findByRole('menu');
    expect(menu).toHaveAttribute('data-align', 'start');
    expect(menu.className).toContain('min-w-(--radix-dropdown-menu-trigger-width)');
    expect(menu.className).not.toContain('min-w-[max(');
  });

  it('lists a repeated value once', async () => {
    const user = userEvent.setup();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <SelectMenu
        label="Genre"
        value=""
        options={[{ value: '', label: 'Any' }, { value: '', label: 'All' }, ...options]}
        onChange={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Genre: Any' }));
    expect(await screen.findAllByRole('menuitem')).toHaveLength(3);
    expect(errors.mock.calls.some((call) => String(call[0]).includes('same key'))).toBe(false);
    errors.mockRestore();
  });

  it('draws one arrow, and falls back to the placeholder for an unlisted value', () => {
    render(
      <SelectMenu
        label="Keep"
        value="9"
        placeholder="Keep 9"
        options={options}
        onChange={vi.fn()}
      />,
    );
    const trigger = screen.getByRole('button', { name: 'Keep: Keep 9' });
    expect(trigger.querySelectorAll('svg')).toHaveLength(1);
  });
});
