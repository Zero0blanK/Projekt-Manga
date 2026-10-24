import { fireEvent, render, screen } from '@testing-library/react';
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
describe('v2 library pagination and selection', () => {
  it.each(['grid', 'list'] as const)(
    'bounds %s to 60 titles and preserves selection across pages',
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
      expect(screen.getByLabelText('Select Title 0')).toBeChecked();
      fireEvent.click(screen.getAllByRole('button', { name: 'Next' })[0]);
      expect(screen.queryByLabelText('Select Title 0')).not.toBeInTheDocument();
      expect(screen.getAllByRole('checkbox')).toHaveLength(60);
      fireEvent.click(screen.getAllByRole('button', { name: 'Next' })[0]);
      expect(screen.getAllByRole('checkbox')).toHaveLength(1);
      expect(screen.getByLabelText('Select Title 120')).toBeChecked();
      fireEvent.click(screen.getByLabelText('Select Title 120'));
      expect(onSelect).toHaveBeenCalledWith('m120');
      expect(screen.getAllByRole('button', { name: 'Next' })[0]).toBeDisabled();
    },
  );
  it('keeps the page across refetches and resets it when the resetKey changes', () => {
    vi.stubGlobal('scrollTo', vi.fn());
    const props = { view: 'grid' as const, onShowAll: vi.fn() };
    const view = render(<LibraryGrid {...props} manga={manga} resetKey="all|title" />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Next' })[0]);
    expect(screen.getAllByText('Page 2 of 3')).toHaveLength(2);
    expect(window.scrollTo).toHaveBeenCalled();
    view.rerender(<LibraryGrid {...props} manga={[...manga]} resetKey="all|title" />);
    expect(screen.getAllByText('Page 2 of 3')).toHaveLength(2);
    view.rerender(<LibraryGrid {...props} manga={[...manga]} resetKey="reading|title" />);
    expect(screen.getAllByText('Page 1 of 3')).toHaveLength(2);
    vi.unstubAllGlobals();
  });
  it('resets an out-of-range page when filters reduce the list', () => {
    const props = { view: 'grid' as const, onShowAll: vi.fn() };
    const view = render(<LibraryGrid {...props} manga={manga} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Next' })[0]);
    view.rerender(<LibraryGrid {...props} manga={manga.slice(0, 1)} />);
    expect(screen.getByRole('link', { name: 'Title 0' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });
});
