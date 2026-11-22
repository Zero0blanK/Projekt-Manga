'use client';

import { useLayoutEffect, useRef, useState } from 'react';

/**
 * A title's synopsis, held to three lines with "Show more" when it runs longer.
 *
 * Whether it runs longer is measured, not guessed from its length: how much fits in three
 * lines depends on the column's width and the font, so a character count offered a
 * "Show more" that showed nothing more. The button is there only while the text really
 * overflows (and, once expanded, to take it back to three lines), and the measurement is
 * redone when the column changes width.
 */
export function MangaSynopsis({ synopsis }: { synopsis: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const paragraph = useRef<HTMLParagraphElement>(null);
  const text = synopsis.trim();

  useLayoutEffect(() => {
    const element = paragraph.current;
    // Expanded, the text shows in full and can't be measured against three lines: keep
    // the answer from before it opened, so "Show less" stays.
    if (!element || expanded) return;
    const measure = () => setOverflows(element.scrollHeight > element.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, expanded]);

  // Nothing to show or expand for an empty synopsis.
  if (!text) return null;

  return (
    <>
      <p
        ref={paragraph}
        className={`mt-3 max-w-3xl text-sm leading-relaxed text-foreground/80 ${
          expanded ? '' : 'line-clamp-3'
        }`}
      >
        {text}
      </p>
      {(overflows || expanded) && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="mt-1 text-xs font-medium text-primary hover:opacity-80 pointer-coarse:inline-flex pointer-coarse:min-h-6 pointer-coarse:items-center"
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </>
  );
}
