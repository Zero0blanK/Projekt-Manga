/**
 * The counts shown on library covers (unread, downloaded, latest chapter): where they sit
 * and how they look. Settings > Appearance > Cover badges.
 */

export const COVER_BADGE_POSITIONS = [
  { value: 'top-left', label: 'Top left' },
  { value: 'top-right', label: 'Top right' },
  { value: 'bottom-left', label: 'Bottom left' },
  { value: 'bottom-right', label: 'Bottom right' },
  { value: 'below-title', label: 'Under the title' },
] as const;

export type CoverBadgePosition = (typeof COVER_BADGE_POSITIONS)[number]['value'];
export type CornerPosition = Exclude<CoverBadgePosition, 'below-title'>;

/** Joined: one block split into coloured segments in a corner, as Mihon does. Pills: a
 * separate rounded chip for each count, with its words ("3 unread"). */
export const COVER_BADGE_STYLES = [
  { value: 'joined', label: 'Joined block' },
  { value: 'pills', label: 'Separate pills' },
] as const;

export type CoverBadgeStyle = (typeof COVER_BADGE_STYLES)[number]['value'];

export const COVER_BADGE_POSITION_SETTING = 'coverBadgePosition';
export const COVER_BADGE_STYLE_SETTING = 'coverBadgeStyle';
export const DOWNLOAD_BADGE_SETTING = 'showDownloadBadge';

export const DEFAULT_COVER_BADGE_POSITION: CoverBadgePosition = 'top-left';
export const DEFAULT_COVER_BADGE_STYLE: CoverBadgeStyle = 'joined';

export function resolveBadgePosition(value: unknown): CoverBadgePosition {
  return COVER_BADGE_POSITIONS.some((option) => option.value === value)
    ? (value as CoverBadgePosition)
    : DEFAULT_COVER_BADGE_POSITION;
}

export function resolveBadgeStyle(value: unknown): CoverBadgeStyle {
  return COVER_BADGE_STYLES.some((option) => option.value === value)
    ? (value as CoverBadgeStyle)
    : DEFAULT_COVER_BADGE_STYLE;
}

/**
 * The corner the counts take on a cover. "Under the title" falls back to the top left where
 * there is no title line (a bare cover). The compact grid lays its title over the bottom
 * of the cover, so a bottom corner moves to the top there instead of hiding under it.
 */
export function coverCorner(
  position: CoverBadgePosition,
  { titleOnCover = false }: { titleOnCover?: boolean } = {},
): CornerPosition {
  if (position === 'below-title') return 'top-left';
  if (titleOnCover && position.startsWith('bottom')) {
    return position === 'bottom-left' ? 'top-left' : 'top-right';
  }
  return position;
}

export const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
