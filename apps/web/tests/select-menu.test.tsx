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
