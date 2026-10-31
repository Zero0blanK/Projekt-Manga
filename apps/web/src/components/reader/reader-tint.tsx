'use client';

import { useSetting } from '@/lib/app-store';
import {
  DEFAULT_TINT_CUSTOM,
  READER_TINT_BLEND,
  READER_TINT_CUSTOM,
  readerTintColor,
  tintBlendMode,
  tintOpacity,
} from '@/lib/page-image';

/**
 * Settings > Reader > Tint. Like the brightness overlay it sits above the pages at z-20 and
 * below the z-30 reader chrome. Multiply (the default) colours the paper and leaves ink
 * black; screen lightens, overlay deepens contrast. "Custom" takes its colour from the
 * colour picker beside it.
 */
export function ReaderTintOverlay({ tint, strength }: { tint: string; strength: number }) {
  const custom = useSetting(READER_TINT_CUSTOM, DEFAULT_TINT_CUSTOM) as string;
  const blend = useSetting(READER_TINT_BLEND, 'Multiply') as string;
  const color = readerTintColor(tint, custom);
  if (!color) return null;
  return (
    <div
      aria-hidden
      data-reader-tint={tint}
      className="pointer-events-none fixed inset-0 z-20"
      style={{
        backgroundColor: color,
        opacity: tintOpacity(strength),
        mixBlendMode: tintBlendMode(blend),
      }}
    />
  );
}
