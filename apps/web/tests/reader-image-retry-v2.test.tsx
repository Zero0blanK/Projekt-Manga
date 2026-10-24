import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MangaPage } from '@/components/reader/manga-page';
import type { Manga } from '@/lib/manga-data';

const manga = { id: 'fixture', title: 'Fixture title' } as Manga;

describe('reader image failures', () => {
  it('retries only the failed page and reports readiness only after the replacement loads', () => {
    const ready = vi.fn();
    render(
      <>
        <MangaPage
          manga={manga}
          pageNumber={1}
          totalPages={2}
          imageUrl="/one.png"
          onReady={ready}
        />
        <MangaPage manga={manga} pageNumber={2} totalPages={2} imageUrl="/two.png" />
      </>,
    );
    const first = screen.getByRole('img', { name: /page 1 of 2/ });
    const second = screen.getByRole('img', { name: /page 2 of 2/ });
    fireEvent.error(first);
    expect(screen.getByRole('alert')).toHaveTextContent('Page 1 could not load.');
    expect(ready).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry page 1' }));
    const replacement = screen.getByRole('img', { name: /page 1 of 2/ });
    expect(replacement).not.toBe(first);
    expect(screen.getByRole('img', { name: /page 2 of 2/ })).toBe(second);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(ready).not.toHaveBeenCalled();
    fireEvent.load(replacement);
    expect(ready).toHaveBeenCalledTimes(1);
  });

  it('clears a previous page error when its URL changes', () => {
    const { rerender } = render(
      <MangaPage manga={manga} pageNumber={1} totalPages={1} imageUrl="/old.png" />,
    );
    fireEvent.error(screen.getByRole('img'));
    rerender(<MangaPage manga={manga} pageNumber={1} totalPages={1} imageUrl="/new.png" />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('img')).toHaveAttribute('src', '/new.png');
  });
});
