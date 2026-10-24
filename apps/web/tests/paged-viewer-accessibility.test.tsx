import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Manga } from '@/lib/manga-data';
import { PagedViewer } from '@/components/reader/paged-viewer';

vi.mock('@/lib/app-store', () => ({
  useSetting: (key: string, fallback: unknown) => (key === 'zoomBehavior' ? 'Smart' : fallback),
}));
vi.mock('@/lib/scroll', () => ({ useScrollBehavior: () => 'auto' }));
vi.mock('@/components/reader/manga-page', () => ({
  MangaPage: ({ pageNumber }: { pageNumber: number }) => <div>Page {pageNumber}</div>,
}));

const manga = {
  id: 'm1',
  slug: 'm1',
  title: 'Test manga',
  authors: [],
  artists: [],
  groups: null,
  source: 'fixture',
  chapters: 1,
  latestChapter: '1',
  latestChapterNum: 1,
  updatedAt: '',
  status: 'Ongoing',
  tags: [],
  color: '',
  accent: '',
  synopsis: '',
  rating: null,
  thumbnailUrl: null,
  inLibrary: true,
} satisfies Manga;

function ObserverStub() {
  return class {
    observe() {}
    disconnect() {}
  };
}

function renderViewer() {
  return render(
    <>
      <input aria-label="Search" />
      <textarea aria-label="Notes" />
      <PagedViewer
        manga={manga}
        totalPages={3}
        pageUrls={['one', 'two', 'three']}
        pagesPerView={1}
        page={1}
        onPositionChange={() => undefined}
        hasNextChapter
        nextChapterNumber={2}
        onRequestNextChapter={() => undefined}
        hasPrevChapter
        prevChapterNumber={0}
        onRequestPrevChapter={() => undefined}
      />
    </>,
  );
}

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', ObserverStub());
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('paged reader accessibility', () => {
  it('exposes named previous and next controls and supports keyboard navigation', () => {
    const { container } = renderViewer();
    const units = container.querySelectorAll<HTMLElement>('[data-unit]');
    vi.mocked(units[1].scrollIntoView).mockClear();

    expect(screen.getByRole('button', { name: 'Previous' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'ArrowRight' });

    expect(units[1].scrollIntoView).toHaveBeenCalledWith({
      behavior: 'auto',
      block: 'nearest',
      inline: 'start',
    });
  });

  it('does not steal arrow keys from text inputs or textareas', () => {
    const { container } = renderViewer();
    const secondPage = container.querySelectorAll<HTMLElement>('[data-unit]')[1];
    vi.mocked(secondPage.scrollIntoView).mockClear();

    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Search' }), { key: 'ArrowRight' });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Notes' }), { key: 'ArrowRight' });

    expect(secondPage.scrollIntoView).not.toHaveBeenCalled();
  });
});
