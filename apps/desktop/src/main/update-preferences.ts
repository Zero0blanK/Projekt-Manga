/**
 * The one update setting that has to live outside the renderer.
 *
 * Every other user preference is kept in `localStorage` by apps/web's `lib/app-store.ts`, which
 * the main process cannot read — and this one is needed *in* the main process, *at launch*,
 * before any renderer exists, because it decides whether `autoUpdater.autoDownload` is on before
 * the first check runs. So it gets its own file next to the local database.
 *
 * Same storage idea as auth-cache.ts, deliberately without the encryption: that file holds a
 * session token and uses `safeStorage`; this holds a boolean nobody needs protected.
 */
import { app } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface UpdatePreferences {
  /** Download an available update in the background without asking. */
  autoDownload: boolean;
  /** A version the user chose "Skip this version" for: never offered at launch again. */
  skippedVersion: string | null;
}

/** Downloading by default is the point of the feature — the toggle exists for metered or slow
 * connections, not as the normal case. */
const DEFAULTS: UpdatePreferences = { autoDownload: true, skippedVersion: null };

function preferencesFilePath(): string {
  return path.join(app.getPath('userData'), 'update-preferences.json');
}

/**
 * Never throws.
 *
 * A missing file is the normal first-run state, and a corrupt one is not worth failing over: the
 * cost of guessing wrong is one unwanted (or one skipped) background download, whereas throwing
 * here would happen during `whenReady` and take the whole app down over a preference.
 */
export function getUpdatePreferences(): UpdatePreferences {
  try {
    const parsed: unknown = JSON.parse(readFileSync(preferencesFilePath(), 'utf-8'));
    if (typeof parsed !== 'object' || parsed === null) return DEFAULTS;
    const { autoDownload, skippedVersion } = parsed as Partial<UpdatePreferences>;
    return {
      autoDownload: typeof autoDownload === 'boolean' ? autoDownload : DEFAULTS.autoDownload,
      skippedVersion: typeof skippedVersion === 'string' ? skippedVersion : null,
    };
  } catch {
    return DEFAULTS;
  }
}

/** Persists the toggle. Errors are reported to the caller rather than swallowed — a setting that
 * silently fails to save is worse than one that reports it, since the user would keep re-setting
 * it. */
export function setAutoDownload(autoDownload: boolean): UpdatePreferences {
  return savePreferences({ ...getUpdatePreferences(), autoDownload });
}

/** Remembers "Skip this version" across launches. */
export function setSkippedVersion(skippedVersion: string | null): UpdatePreferences {
  return savePreferences({ ...getUpdatePreferences(), skippedVersion });
}

function savePreferences(next: UpdatePreferences): UpdatePreferences {
  writeFileSync(preferencesFilePath(), JSON.stringify(next, null, 2), 'utf-8');
  return next;
}
