import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { useEffect, useRef, useState } from 'react';

/**
 * Regression cover for the paged reader's keyboard navigation.
 *
 * The effect that binds the window keydown listener has an empty dependency array, so it
 * runs once. The handlers it calls (`advance`/`retreat`) are plain functions recreated
 * every render, closing over a `currentUnitIndex` derived from the current page — so a
 * listener that captured them directly stayed frozen on whatever page the reader was
 * opened at, and the arrow keys navigated relative to that forever.
 *
 * This reproduces the exact shape rather than mounting PagedViewer itself, which needs a
 * chapter, a source, image loading and scroll behaviour to render at all. The bug lives
 * entirely in how the listener reaches the handler, and that is what this pins down.
 */

const seen: number[] = [];

/** The shape paged-viewer.tsx uses: bind once, read handlers through a ref. */
function Fixed() {
  const [page, setPage] = useState(0);
  const advance = () => seen.push(page);
  const navRef = useRef({ advance });
  navRef.current = { advance };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') navRef.current.advance();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return <button onClick={() => setPage((p) => p + 1)}>next</button>;
}

/** The buggy shape: bind once, capture the handler from the first render. */
function Stale() {
  const [page, setPage] = useState(0);
  const advance = () => seen.push(page);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') advance();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <button onClick={() => setPage((p) => p + 1)}>next</button>;
}

beforeEach(() => {
  seen.length = 0;
  vi.clearAllMocks();
});

describe('paged reader keyboard navigation', () => {
  it('acts on the page the reader is currently on, not the one it opened at', () => {
    const { getByText } = render(<Fixed />);

    fireEvent.click(getByText('next'));
    fireEvent.click(getByText('next'));
    fireEvent.keyDown(window, { key: 'ArrowRight' });

    expect(seen).toEqual([2]);
  });

  it('demonstrates the stale-closure shape this replaced', () => {
    const { getByText } = render(<Stale />);

    fireEvent.click(getByText('next'));
    fireEvent.click(getByText('next'));
    fireEvent.keyDown(window, { key: 'ArrowRight' });

    // Two pages further on, but the listener still reports the page it was bound at.
    expect(seen).toEqual([0]);
  });
});
