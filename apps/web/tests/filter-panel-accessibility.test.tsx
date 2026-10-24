import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { MangaFilter } from '@projekt-manga/types';

const { FilterPanel } = await import('@/components/discover/filter-panel');

/**
 * Every filter control has to be reachable by name.
 *
 * The panel renders each filter through one `FilterSection`. A visual-only label leaves
 * the `<select>` and free-text field unnamed and the pill groups (up to 38 buttons for a
 * tag list) announced as an unnamed group. Assertions use accessible names rather than
 * class or DOM position so they survive restyling.
 */
const fields: MangaFilter[] = [
  {
    label: 'Status',
    value: 'status',
    type: 'select',
    options: [{ label: 'Ongoing', value: 'ongoing' }],
  },
  { label: 'Author', value: 'author', type: 'text' },
  {
    label: 'Genres',
    value: 'genres',
    type: 'multi',
    options: [{ label: 'Action', value: 'action' }],
  },
];

describe('FilterPanel accessibility', () => {
  it('names the dropdown and the free-text field after their filter', () => {
    render(<FilterPanel fields={fields} values={{}} onApply={vi.fn()} />);

    expect(screen.getByRole('combobox', { name: 'Status' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Author' })).toBeTruthy();
  });

  it('names each filter group so a pill row is not announced as an unnamed region', () => {
    render(<FilterPanel fields={fields} values={{}} onApply={vi.fn()} />);

    // A <section> is only exposed as a `region` once it has an accessible name —
    // without one it is a generic container with no role, so these queries fail
    // outright if the aria-labelledby link is dropped.
    expect(screen.getByRole('region', { name: 'Genres' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Status' })).toBeTruthy();
  });
});
