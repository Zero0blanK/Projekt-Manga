'use client';

import { useId } from 'react';
import { actions } from '@/lib/app-store';

/**
 * A speed control sized for the reader's own chrome.
 *
 * Settings has `Range`, but it is built for a settings row. The reader bar is dark,
 * cramped and shares a wrapping flex row with the auto-scroll button and the translation
 * picker, so this is narrower, labelled inline, and uses white-on-dark tokens to stay
 * legible over a page.
 *
 * Writes straight to the setting rather than holding local state: the slider and
 * Settings > Reader share one value, so changing it here is a preference change, not a
 * per-session one.
 */
export function ReaderSpeedSlider({
  label,
  settingKey,
  value,
  min,
  max,
  step,
  format,
}: {
  label: string;
  settingKey: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
}) {
  const id = useId();
  return (
    <span className="inline-flex items-center gap-1.5">
      <label htmlFor={id} className="whitespace-nowrap text-white/70">
        {label}
      </label>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => actions.setSetting(settingKey, Number(event.target.value))}
        className="h-1 w-20 cursor-pointer appearance-none rounded-full bg-white/25 accent-primary"
      />
      {/* tabular-nums so the row does not reflow as the number changes width while
          dragging, which would shift the slider under the pointer. */}
      <output htmlFor={id} className="w-8 text-right tabular-nums text-white/70">
        {format(value)}
      </output>
    </span>
  );
}
