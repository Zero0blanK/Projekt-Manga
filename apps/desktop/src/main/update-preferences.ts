/**
 * The one update setting that has to live outside the renderer.
 *
 * Every other user preference is kept in `localStorage` by apps/web's `lib/app-store.ts`, which
 * the main process cannot read, and this one decides whether the prompt is raised before any
 * renderer exists. So it gets its own file next to the local database.
 */
import { app } from 'electron';
import { readFileSync } from 'node:fs';
import { writeFileAtomic } from './atomic-file';
import path from 'node:path';

export interface UpdatePreferences {
  /** A version the user chose "Skip this version" for: never offered at launch again. */
  skippedVersion: string | null;
}

const DEFAULTS: UpdatePreferences = { skippedVersion: null };

function preferencesFilePath(): string {
  return path.join(app.getPath('userData'), 'update-preferences.json');
}

/**
 * Never throws: a missing file is the normal first-run state, and a corrupt one is not worth
 * failing over during `whenReady`. The worst case is offering a version that was skipped.
 */
export function getUpdatePreferences(): UpdatePreferences {
  try {
    const parsed: unknown = JSON.parse(readFileSync(preferencesFilePath(), 'utf-8'));
    if (typeof parsed !== 'object' || parsed === null) return DEFAULTS;
    const { skippedVersion } = parsed as Partial<UpdatePreferences>;
    return { skippedVersion: typeof skippedVersion === 'string' ? skippedVersion : null };
  } catch {
    return DEFAULTS;
  }
}

/** Remembers "Skip this version" across launches. */
export function setSkippedVersion(skippedVersion: string | null): UpdatePreferences {
  return savePreferences({ skippedVersion });
}

function savePreferences(next: UpdatePreferences): UpdatePreferences {
  writeFileAtomic(preferencesFilePath(), JSON.stringify(next, null, 2), 'utf-8');
  return next;
}
