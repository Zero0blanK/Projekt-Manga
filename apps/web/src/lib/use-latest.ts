import { useRef } from 'react';

/**
 * A ref that always holds this render's value.
 *
 * For an effect that has to read the newest value of something without re-running when it
 * changes: a callback passed inline, or a list that's only looked at when something else
 * changes. Read it inside the effect, not during render.
 */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
