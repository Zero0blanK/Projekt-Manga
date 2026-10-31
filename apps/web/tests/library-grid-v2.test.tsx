import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { Manga } from '@/lib/manga-data';

// The real card renders selection as a highlighted cover; a checkbox stand-in exposes the
// same `selected`/`onSelect` contract to assertions.
type CardProps = { manga: Manga; selected?: boolean; onSelect?: () => void };
function CardStandIn({ manga, selected, onSelect }: CardProps) {
  return (
    <div>
      <a href={`/manga/${manga.id}`}>{manga.title}</a>
      <input
        type="checkbox"
        aria-label={`Select ${manga.title}`}
        checked={!!selected}
        onChange={() => onSelect?.()}
      />
    </div>
  );
}
vi.mock('@/components/manga-card', () => ({ MangaCard: CardStandIn }));
vi.mock('@/components/library/library-list-row', () => ({ LibraryListRow: CardStandIn }));
vi.mock('@/components/library/library-title-context-menu', () => ({
  LibraryTitleContextMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('@/lib/library-store', () => ({ useMangaLibrary: () => ({ refresh: vi.fn() }) }));
const { LibraryGrid } = await import('@/components/library/library-grid');
const manga = Array.from({ length: 121 }, (_, i) => ({
  id: `m${i}`,
  title: `Title ${i}`,
})) as Manga[];

// Every observer created; `reachEnd` tells them all the end of the list came into view.
const observers: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = [];
vi.stubGlobal(
  'IntersectionObserver',
  class {
    constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
      observers.push(callback);
    }
    observe() {}
    disconnect() {}
  },
);
const reachEnd = () =>
  act(() => {
    for (const callback of observers.splice(0)) callback([{ isIntersecting: true }]);
  });
describe('v2 library infinite loading and selection', () => {
  it.each(['grid', 'list'] as const)(
    'mounts %s titles 60 at a time as the end comes into view, keeping selection',
    (view) => {
      const onSelect = vi.fn();
      render(
        <LibraryGrid
          manga={manga}
          view={view}
          onShowAll={vi.fn()}
          onSelect={onSelect}
          selected={['m0', 'm120']}
          density="compact"
        />,
      );
      expect(screen.getAllByRole('checkbox')).toHaveLength(60);
      expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
      reachEnd();
      expect(screen.getAllByRole('checkbox')).toHaveLength(120);
      reachEnd();
      expect(screen.getAllByRole('checkbox')).toHaveLength(121);
      expect(screen.getByLabelText('Select Title 0')).toBeChecked();
      expect(screen.getByLabelText('Select Title 120')).toBeChecked();
      fireEvent.click(screen.getByLabelText('Select Title 120'));
      expect(onSelect).toHaveBeenCalledWith('m120');
    },
  );
  it('keeps the loaded rows across refetches and starts over when the resetKey changes', () => {
    const props = { view: 'list' as const, onShowAll: vi.fn() };
    const view = render(<LibraryGrid {...props} manga={manga} resetKey="all|title" />);
    reachEnd();
    expect(screen.getAllByRole('checkbox')).toHaveLength(120);
    view.rerender(<LibraryGrid {...props} manga={[...manga]} resetKey="all|title" />);
    expect(screen.getAllByRole('checkbox')).toHaveLength(120);
    view.rerender(<LibraryGrid {...props} manga={[...manga]} resetKey="reading|title" />);
    expect(screen.getAllByRole('checkbox')).toHaveLength(60);
  });
  it('shows a shorter list in full when filters reduce it', () => {
    const props = { view: 'grid' as const, onShowAll: vi.fn() };
    const view = render(<LibraryGrid {...props} manga={manga} />);
    view.rerender(<LibraryGrid {...props} manga={manga.slice(0, 1)} />);
    expect(screen.getByRole('link', { name: 'Title 0' })).toBeInTheDocument();
  });
});
