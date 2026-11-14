'use client';

import { useLayoutEffect, useRef, type CSSProperties } from 'react';

/**
 * A translation drawn over a speech bubble, at the largest size that fits inside it.
 *
 * Starts from `maxSize` (in `cqw`, a share of the page's width, so it scales with zoom) and
 * shrinks until the text no longer overflows the box, measured in the page: an estimate
 * from character counts alone made short lines huge and long ones spill out of the bubble.
 */
export function FittedText({
  text,
  lang,
  maxSize,
  minSize = 0.9,
  style,
}: {
  text: string;
  lang: string;
  maxSize: number;
  minSize?: number;
  style: CSSProperties;
}) {
  const box = useRef<HTMLParagraphElement>(null);

  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const fit = () => {
      let low = minSize;
      let high = Math.max(minSize, maxSize);
      // Binary search on the size: about eight layouts, whatever the text length.
      for (let step = 0; step < 8; step++) {
        const size = (low + high) / 2;
        element.style.fontSize = `${size}cqw`;
        const overflows =
          element.scrollHeight > element.clientHeight + 1 ||
          element.scrollWidth > element.clientWidth + 1;
        if (overflows) high = size;
        else low = size;
      }
      element.style.fontSize = `${low}cqw`;
    };
    fit();
    // The box follows the page's size (zoom, window); refit when it changes.
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, maxSize, minSize]);

  return (
    <p
      ref={box}
      lang={lang}
      className="absolute flex items-center justify-center overflow-hidden rounded-[0.4em] bg-white/95 p-[0.15em] text-center leading-[1.15] font-medium text-balance text-black hyphens-auto"
      style={style}
    >
      {text}
    </p>
  );
}
