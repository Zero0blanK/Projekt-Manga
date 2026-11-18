import { describe, expect, it } from 'vitest';
import { MAX_CATEGORY_NAME, categoryNameProblem } from '@/lib/category-names';

const taken = { shelves: ['All', 'Reading', 'Completed'], categories: ['Favourites'] };

describe('category names', () => {
  it('accepts a new name, and ignores an empty one', () => {
    expect(categoryNameProblem('Isekai', taken)).toBeNull();
    expect(categoryNameProblem('   ', taken)).toBeNull();
    expect(categoryNameProblem('😀 <b>x</b>', taken)).toBeNull();
  });

  it("refuses a name longer than the server takes, before it's sent", () => {
    expect(categoryNameProblem('A'.repeat(MAX_CATEGORY_NAME), taken)).toBeNull();
    expect(categoryNameProblem('A'.repeat(MAX_CATEGORY_NAME + 1), taken)).toMatch(/up to 100/);
  });

  it("refuses a shelf's name, which would show as a second identical pill", () => {
    expect(categoryNameProblem('reading', taken)).toBe(
      '“Reading” is already a shelf. Pick another name.',
    );
    expect(categoryNameProblem(' All ', taken)).toMatch(/already a shelf/);
  });

  it('refuses a duplicate, ignoring case, but lets a category keep its own name', () => {
    expect(categoryNameProblem('favourites', taken)).toMatch(/already a category/);
    expect(categoryNameProblem('Favourites', { ...taken, current: 'Favourites' })).toBeNull();
  });
});
