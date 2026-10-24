import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { useEffect, useRef, useState } from 'react';

/**
 * Regression cover for the long-strip reader's position reporting.
 *
 * The IntersectionObserver that reports "which chapter/page is on screen" is created only
 * when the loaded set changes, so it must reach the current `onPositionChange` through a
 * ref. The parent's handler compares the reported chapter against its own `chapter` state
 * (`reader/[id]/client.tsx`'s handleStreamPosition) and is recreated every render — so a
 * captured copy compared against a *stale* chapter. Scrolling back into an
 * already-loaded chapter then failed to update the chapter or the URL, and because `page`
 * kept updating, the auto-mark-read effect could resolve the wrong chapter and mark a
 * chapter the reader had not finished.
 *
 * Modelled rather than mounting LongStripViewer, which needs a manga, fetched pages,
 * scroll containers and a live IntersectionObserver to render at all. The defect is
 * entirely in how the observer reaches the handler, which is what these pin down.
 */

/** Stands in for the observer: created once, invoked later. */
let fire: ((chapter: number) => void) | null = null;
const reported: number[] = [];

function Parent({ mode }: { mode: 'fixed' | 'stale' }) {
  const [chapter, setChapter] = useState(1);

  // The real handler's shape: closes over `chapter`, recreated every render.
  const onPositionChange = (visibleChapter: number) => {
    if (visibleChapter !== chapter) {
      setChapter(visibleChapter);
      reported.push(visibleChapter);
    }
  };

  const ref = useRef(onPositionChange);
  ref.current = onPositionChange;

  useEffect(() => {
    fire = mode === 'fixed' ? (c) => ref.current(c) : (c) => onPositionChange(c);
    return () => {
      fire = null;
    };
    // Deliberately empty, exactly like the observer effect it models.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <span data-testid="chapter">{chapter}</span>;
}

beforeEach(() => {
  reported.length = 0;
  fire = null;
  vi.clearAllMocks();
});

describe('long-strip position reporting', () => {
  it('reports a chapter change again after scrolling back into an earlier chapter', () => {
    const { getByTestId } = render(<Parent mode="fixed" />);

    act(() => fire!(2)); // scrolled forward into chapter 2
    expect(getByTestId('chapter').textContent).toBe('2');

    act(() => fire!(1)); // scrolled back into chapter 1

    // The whole bug: this second transition was silently dropped, leaving the parent —
    // and the URL — claiming chapter 2 while the reader was looking at chapter 1.
    expect(reported).toEqual([2, 1]);
    expect(getByTestId('chapter').textContent).toBe('1');
  });

  it('demonstrates the stale-closure shape this replaced', () => {
    const { getByTestId } = render(<Parent mode="stale" />);

    act(() => fire!(2));
    act(() => fire!(1));

    // The captured handler still compares against chapter 1 from the first render, so
    // scrolling back reads as "no change" and the parent stays on 2.
    expect(reported).toEqual([2]);
    expect(getByTestId('chapter').textContent).toBe('2');
  });

  it('does not report a change while staying inside one chapter', () => {
    render(<Parent mode="fixed" />);

    act(() => fire!(1));
    act(() => fire!(1));

    expect(reported).toEqual([]);
  });
});
