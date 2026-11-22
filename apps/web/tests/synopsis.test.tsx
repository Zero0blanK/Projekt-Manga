import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MangaSynopsis } from '@/components/manga-detail/synopsis';

/** jsdom lays nothing out: stand in the paragraph's full and three-line heights. */
function heights(full: number, clamped: number) {
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get: () => full,
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => clamped,
  });
}

afterEach(() => {
  cleanup();
  heights(0, 0);
});

const LONG = 'A long synopsis that runs well past three lines of the column. '.repeat(8);

describe('the synopsis', () => {
  it('offers no Show more when the text fits in three lines, however long it is', () => {
    heights(60, 60);
    render(<MangaSynopsis synopsis={LONG} />);
    expect(screen.queryByRole('button', { name: /Show/ })).toBeNull();
  });

  it('shows more and less when the text overflows three lines', () => {
    heights(200, 60);
    render(<MangaSynopsis synopsis={LONG} />);
    const button = screen.getByRole('button', { name: 'Show more' });
    fireEvent.click(button);
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show less' }));
    expect(screen.getByRole('button', { name: 'Show more' })).toBeInTheDocument();
  });
});
