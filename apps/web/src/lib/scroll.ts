'use client';

import { useSetting } from '@/lib/app-store';

/**
 * Settings > Appearance > Smooth scrolling. Reduce motion wins over it — someone who has
 * asked for less movement shouldn't have to switch this off separately.
 */
export function useScrollBehavior(): ScrollBehavior {
  const smooth = useSetting('smoothScroll', true) as boolean;
  const reduceMotion = useSetting('reduceMotion', false) as boolean;
  return smooth && !reduceMotion ? 'smooth' : 'auto';
}
