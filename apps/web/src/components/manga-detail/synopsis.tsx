'use client';

import { useState } from 'react';

/** Roughly three lines at the synopsis width; shorter text has nothing to expand. */
const CLAMP_THRESHOLD = 220;

export function MangaSynopsis({ synopsis }: { synopsis: string }) {
  const [expanded, setExpanded] = useState(false);
  const text = synopsis.trim();
  // Nothing to show or expand for an empty synopsis.
  if (!text) return null;
  const clampable = text.length > CLAMP_THRESHOLD;

  return (
    <>
      <p
        className={`mt-3 max-w-2xl text-sm leading-relaxed text-foreground/80 ${
          expanded || !clampable ? '' : 'line-clamp-3'
        }`}
      >
        {text}
      </p>
      {clampable && (
        <button
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
