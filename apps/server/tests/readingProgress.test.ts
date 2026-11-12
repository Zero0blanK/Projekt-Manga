import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { foldReadingProgress, mergePushedReadingProgress } from '../src/utils/readingProgress.js';

// The desktop cache runs this same table (apps/desktop/tests/reading-progress.cjs), which
// is what keeps the two implementations of the rule from drifting apart.
const cases = JSON.parse(
  readFileSync(
    new URL('../../../packages/types/fixtures/reading-progress-cases.json', import.meta.url),
    'utf8',
  ),
) as {
  fold: { name: string; a: Progress; b: Progress; expect: Progress }[];
  push: { name: string; existing: Stamped; incoming: Stamped; expect: Progress }[];
};
type Progress = { is_read: boolean; is_bookmark: boolean; last_page_read: number };
type Stamped = Progress & { updated_at: string };

const dated = (row: Stamped) => ({ ...row, updated_at: new Date(row.updated_at) });

describe('folding two records of one reader', () => {
  for (const { name, a, b, expect: expected } of cases.fold) {
    it(name, () => {
      expect(foldReadingProgress(a, b)).toEqual(expected);
      expect(foldReadingProgress(b, a)).toEqual(expected);
    });
  }

  it('counts a missing record or field as no progress', () => {
    const state = { is_read: true, is_bookmark: false, last_page_read: 4 };
    expect(foldReadingProgress(null, state)).toEqual(state);
    expect(foldReadingProgress(state, { last_page_read: null })).toEqual(state);
  });
});

describe('merging a pushed state into the stored one', () => {
  for (const { name, existing, incoming, expect: expected } of cases.push) {
    it(name, () => {
      expect(mergePushedReadingProgress(dated(existing), dated(incoming))).toEqual(expected);
    });
  }
});
