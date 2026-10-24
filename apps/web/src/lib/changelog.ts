import changelog from '@/data/changelog.json';

/**
 * Release notes, read from `src/data/changelog.json`.
 *
 * JSON rather than a `.ts` array so a release is pure data — editable (and diffable)
 * without touching component code, and usable by anything else that needs the version.
 * It's imported, not fetched, so it's bundled at build time: no request, no loading state,
 * and a malformed file fails the build instead of the page.
 */

export type ChangeType = 'added' | 'changed' | 'fixed' | 'removed';

export type Change = { type: ChangeType; text: string };

export type Release = {
  version: string;
  date: string;
  changes: Change[];
};

export const RELEASES: Release[] = changelog.releases as Release[];

/** The newest release — the single source of truth for the version the About panel shows. */
export const CURRENT_RELEASE: Release = RELEASES[0];

export const CHANGE_LABELS: Record<ChangeType, string> = {
  added: 'New',
  changed: 'Changed',
  fixed: 'Fixed',
  removed: 'Removed',
};
