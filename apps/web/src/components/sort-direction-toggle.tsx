import { ArrowUp, ArrowDown } from 'lucide-react';

export type SortDirection = 'asc' | 'desc';

/** Small arrow shown on the active sort option; clicking that option again flips direction (bi-directional sort). */
export function SortDirectionIcon({ direction }: { direction: SortDirection }) {
  return direction === 'asc' ? (
    <ArrowUp className="h-3.5 w-3.5" />
  ) : (
    <ArrowDown className="h-3.5 w-3.5" />
  );
}
