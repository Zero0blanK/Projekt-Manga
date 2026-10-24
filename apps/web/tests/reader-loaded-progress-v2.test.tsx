import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PagedViewer } from '@/components/reader/paged-viewer';
import type { Manga } from '@/lib/manga-data';

vi.mock('@/lib/app-store', () => ({ useSetting: (_key: string, fallback: unknown) => fallback }));
vi.mock('@/lib/scroll', () => ({ useScrollBehavior: () => 'auto' }));
let intersect: IntersectionObserverCallback;
beforeEach(() => {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: IntersectionObserverCallback) {
        intersect = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function viewer(
  progress: (page: number) => void,
  urls = ['/one.png', '/two.png'],
  toggle?: () => void,
) {
  return (
    <PagedViewer
      manga={{ id: 'fixture', title: 'Fixture title' } as Manga}
      totalPages={2}
      pageUrls={urls}
      pagesPerView={2}
      page={1}
      onPositionChange={progress}
      hasNextChapter={false}
      nextChapterNumber={2}
      onRequestNextChapter={() => undefined}
      hasPrevChapter={false}
      prevChapterNumber={0}
      onRequestPrevChapter={() => undefined}
      completionActions={<button>Return to library</button>}
      tapActions={{ left: 'None', center: 'Controls', right: 'None' }}
      onToggleControls={toggle}
    />
  );
}

describe('reader progress admission', () => {
  it('handles a center tap while excluding drags, dialogs and canceled gestures', () => {
    const toggle = vi.fn();
    const { container } = render(viewer(vi.fn(), undefined, toggle));
    const strip = container.querySelector('[data-unit]')!.parentElement!;
    vi.spyOn(strip, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 300 } as DOMRect);
    const pointer = (type: string, x: number) => {
      const event = new Event(type, { bubbles: true });
      Object.assign(event, { isPrimary: true, button: 0, clientX: x, clientY: 10, pointerId: 1 });
      fireEvent(strip, event);
    };
    pointer('pointerdown', 150);
    pointer('pointerup', 150);
    expect(toggle).toHaveBeenCalledTimes(1);
    pointer('pointerdown', 150);
    pointer('pointerup', 190);
    pointer('pointerdown', 150);
    pointer('pointercancel', 150);
    pointer('pointerup', 150);
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.appendChild(dialog);
    pointer('pointerdown', 150);
    pointer('pointerup', 150);
    dialog.remove();
    expect(toggle).toHaveBeenCalledTimes(1);
  });
  it('requires every image in the visible spread to load and does not auto-advance chapters', () => {
    const progress = vi.fn();
    const { container } = render(viewer(progress));
    act(() =>
      intersect(
        [
          {
            target: container.querySelector('[data-unit]')!,
            isIntersecting: true,
            intersectionRatio: 1,
          } as IntersectionObserverEntry,
        ],
        {} as IntersectionObserver,
      ),
    );
    expect(progress).not.toHaveBeenCalled();
    fireEvent.load(screen.getByRole('img', { name: /page 1 of 2/ }));
    fireEvent.error(screen.getByRole('img', { name: /page 2 of 2/ }));
    expect(progress).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry page 2' }));
    fireEvent.load(screen.getByRole('img', { name: /page 2 of 2/ }));
    expect(progress).toHaveBeenCalledWith(2);
    expect(screen.getByRole('button', { name: 'Return to library' })).toBeInTheDocument();
  });

  it('does not reuse readiness from a different chapter image URL', () => {
    const progress = vi.fn();
    const { container, rerender } = render(viewer(progress));
    fireEvent.load(screen.getByRole('img', { name: /page 1 of 2/ }));
    fireEvent.load(screen.getByRole('img', { name: /page 2 of 2/ }));
    progress.mockClear();
    rerender(viewer(progress, ['/new-one.png', '/new-two.png']));
    act(() =>
      intersect(
        [
          {
            target: container.querySelector('[data-unit]')!,
            isIntersecting: true,
            intersectionRatio: 1,
          } as IntersectionObserverEntry,
        ],
        {} as IntersectionObserver,
      ),
    );
    expect(progress).not.toHaveBeenCalled();
    fireEvent.load(screen.getByRole('img', { name: /page 1 of 2/ }));
    expect(progress).not.toHaveBeenCalled();
    fireEvent.load(screen.getByRole('img', { name: /page 2 of 2/ }));
    expect(progress).toHaveBeenCalledWith(2);
  });
});
