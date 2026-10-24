import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/app-store', () => ({ useSetting: (_key: string, fallback: string) => fallback }));
// jsdom has no IntersectionObserver; an inert one keeps reveals to what each test sets up.
vi.stubGlobal(
  'IntersectionObserver',
  class {
    observe() {}
    disconnect() {}
  },
);

const { MangaGrid } = await import('@/components/manga-grid');

function cards(count: number) {
  return Array.from({ length: count }, (_, index) => <span key={index}>Card {index}</span>);
}

describe('MangaGrid progressive reveal', () => {
  it('keeps already revealed covers when an infinite-scroll page is appended', () => {
    const view = render(<MangaGrid>{cards(120)}</MangaGrid>);
    expect(screen.getAllByText(/^Card /)).toHaveLength(120);
    // Crossing the progressive threshold must not collapse the grid back to 60 covers,
    // which would shrink the page and yank the reader's scroll position up.
    view.rerender(<MangaGrid>{cards(140)}</MangaGrid>);
    expect(screen.getAllByText(/^Card /)).toHaveLength(120);
    view.rerender(<MangaGrid>{cards(160)}</MangaGrid>);
    expect(screen.getAllByText(/^Card /)).toHaveLength(120);
  });

  it('starts over from the first chunk when the list is replaced by a shorter one', () => {
    const view = render(<MangaGrid revealAtLeast={300}>{cards(300)}</MangaGrid>);
    expect(screen.getAllByText(/^Card /)).toHaveLength(300);
    view.rerender(<MangaGrid>{cards(200)}</MangaGrid>);
    expect(screen.getAllByText(/^Card /)).toHaveLength(60);
  });

  it('mounts at least the requested number of covers so a restored page can scroll back', () => {
    render(<MangaGrid revealAtLeast={250}>{cards(400)}</MangaGrid>);
    expect(screen.getAllByText(/^Card /)).toHaveLength(250);
  });
});
