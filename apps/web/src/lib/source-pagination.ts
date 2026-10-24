import type { Mangas, SourceCataloguePage } from '@projekt-manga/types';
import { mergeSourceResults } from './source-results';

/** Reject stalled pages before committing their cursor so a retry repeats the same request. */
export function appendSourcePage(
  previous: Mangas[],
  page: SourceCataloguePage,
  usedCursors: ReadonlySet<string>,
): Mangas[] {
  const items = mergeSourceResults(previous, page.items);
  if (
    page.hasMore &&
    (!page.nextCursor || usedCursors.has(page.nextCursor) || items.length === previous.length)
  ) {
    throw new Error('This source returned a page that cannot advance. Retry to load more results.');
  }
  return items;
}
