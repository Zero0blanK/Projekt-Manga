import { describe, expect, it } from 'vitest';
import type { Mangas } from '@projekt-manga/types';
import { mergeSourceResults } from '@/lib/source-results';
describe('source-result identity', () => {
  it('removes duplicates within and across pages and retains independent source identities', () => {
    const row = (source: string, id: string, title = id) => ({ source, id, title }) as Mangas;
    const first = row('weebcentral', 'one', 'Original metadata');
    expect(
      mergeSourceResults(
        [first, first],
        [
          row('weebcentral', 'one', 'Duplicate'),
          row('weebcentral', 'two'),
          row('weebcentral', 'two'),
          row('other', 'one'),
        ],
      ),
    ).toEqual([first, row('weebcentral', 'two'), row('other', 'one')]);
  });
});
