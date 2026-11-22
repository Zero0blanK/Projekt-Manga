import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { FilterPanel } from '@/components/discover/filter-panel';

afterEach(cleanup);

const genres = Array.from({ length: 30 }, (_, index) => ({
  value: `g${index}`,
  label: `Genre ${index}`,
}));

describe('the browse filter panel', () => {
  it('puts dropdowns side by side and gives the genre pills a row of their own, all shown', () => {
    render(
      <FilterPanel
        fields={[
          { value: 'genre', label: 'Genres', type: 'multi', options: genres },
          {
            value: 'status',
            label: 'Status',
            type: 'select',
            options: [{ value: 'ongoing', label: 'Ongoing' }],
          },
          { value: 'author', label: 'Author', type: 'text' },
        ]}
        values={{}}
        onApply={vi.fn()}
      />,
    );

    // Every genre, with nothing folded behind "+N more".
    for (const genre of genres)
      expect(screen.getByRole('button', { name: genre.label })).toBeVisible();
    expect(screen.queryByRole('button', { name: /more$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show less' })).toBeNull();

    // The dropdown and the text input share one grid; the genres come after it, outside.
    const status = screen.getByRole('button', { name: /^Status/ });
    const author = screen.getByRole('textbox', { name: 'Author' });
    const grid = status.closest('.grid');
    expect(grid).not.toBeNull();
    expect(grid).toContainElement(author);
    expect(grid).not.toContainElement(screen.getByRole('button', { name: 'Genre 0' }));
  });
});
