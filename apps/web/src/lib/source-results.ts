import type { Mangas } from '@projekt-manga/types';

export function mergeSourceResults(previous: Mangas[], incoming: Mangas[]): Mangas[] {
  const seen = new Set<string>();
  return [...previous, ...incoming].filter((item) => {
    const key = `${item.source}:${item.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
