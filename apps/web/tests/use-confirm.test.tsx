import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useConfirm, type Confirm } from '@/hooks/use-confirm';

let ask!: Confirm;
function Harness() {
  const { confirm, dialog } = useConfirm();
  ask = confirm;
  return <>{dialog}</>;
}

const options = { title: 'Remove it?', description: 'Really remove it?', confirmLabel: 'Remove' };

describe('useConfirm', () => {
  it('resolves true when the action is chosen', async () => {
    render(<Harness />);
    let result!: Promise<boolean>;
    act(() => {
      result = ask(options);
    });
    expect(await screen.findByRole('alertdialog', { name: 'Remove it?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await expect(result).resolves.toBe(true);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('resolves false on cancel and on Escape', async () => {
    render(<Harness />);
    let result!: Promise<boolean>;
    act(() => {
      result = ask(options);
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await expect(result).resolves.toBe(false);

    act(() => {
      result = ask(options);
    });
    fireEvent.keyDown(await screen.findByRole('alertdialog'), { key: 'Escape' });
    await expect(result).resolves.toBe(false);
  });

  it('resolves a superseded request as false', async () => {
    render(<Harness />);
    let first!: Promise<boolean>;
    act(() => {
      first = ask(options);
      void ask({ ...options, title: 'Second' });
    });
    await expect(first).resolves.toBe(false);
    expect(await screen.findByRole('alertdialog', { name: 'Second' })).toBeInTheDocument();
  });
});
