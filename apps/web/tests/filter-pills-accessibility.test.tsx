import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { removeCategory, renameCategory } = vi.hoisted(() => ({
  removeCategory: vi.fn(),
  renameCategory: vi.fn(),
}));

vi.mock('@/lib/library-store', () => ({
  useMangaLibrary: () => ({ manga: [] }),
  useLibraryState: () => ({ shelf: {} }),
}));
vi.mock('@/lib/app-store', () => ({
  actions: { removeCategory, renameCategory },
  useAppState: (select: (state: unknown) => unknown) =>
    select({ customCategories: ['Favorites'], categoryMembers: {} }),
}));

const { FilterPills } = await import('@/components/library/filter-pills');

describe('FilterPills accessibility', () => {
  beforeEach(() => vi.clearAllMocks());

  it('gives the new-category field an accessible name, not just a placeholder', async () => {
    const user = userEvent.setup();
    render(<FilterPills filter="all" onChange={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Add category' }));

    // Queried by name: a placeholder alone is not exposed as an accessible name by every
    // screen reader, and it vanishes once the field has a character in it — which this
    // field will, since it takes focus as soon as it opens.
    const field = screen.getByRole('textbox', { name: 'New category name' });
    expect(field).toHaveFocus();
  });

  it('returns focus to the category trigger when rename is cancelled', async () => {
    const user = userEvent.setup();
    render(<FilterPills filter="all" onChange={vi.fn()} />);

    const trigger = screen.getByRole('button', { name: /Favorites/ });
    fireEvent.contextMenu(trigger, { clientX: 20, clientY: 20 });
    await user.click(await screen.findByRole('menuitem', { name: 'Edit' }));
    expect(await screen.findByRole('dialog', { name: 'Rename category' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(trigger).toHaveFocus());
    expect(renameCategory).not.toHaveBeenCalled();
  });

  it('returns focus to the category trigger when delete confirmation is cancelled', async () => {
    const user = userEvent.setup();
    render(<FilterPills filter="all" onChange={vi.fn()} />);

    const trigger = screen.getByRole('button', { name: /Favorites/ });
    fireEvent.contextMenu(trigger, { clientX: 20, clientY: 20 });
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    expect(await screen.findByRole('alertdialog', { name: 'Delete "Favorites"?' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(trigger).toHaveFocus());
    expect(removeCategory).not.toHaveBeenCalled();
  });

  it('offers visible category actions without a context menu and confirms deletion', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<FilterPills filter="Favorites" onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: 'Rename category' }));
    expect(await screen.findByRole('dialog', { name: 'Rename category' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Delete category' }));
    expect(removeCategory).not.toHaveBeenCalled();
    await user.click(await screen.findByRole('button', { name: 'Delete', exact: true }));
    expect(removeCategory).toHaveBeenCalledWith('Favorites');
    expect(onChange).toHaveBeenCalledWith('all');
  });
});
