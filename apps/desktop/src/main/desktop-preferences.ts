/**
 * Desktop window behaviour the main process needs before (or without) a renderer:
 * whether closing the window keeps the app in the tray. Same storage idea as
 * update-preferences.ts — a small JSON file beside the local database.
 */
import { app } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface DesktopPreferences {
  /** Closing the window hides it to the tray, so scheduled library updates keep running. */
  closeToTray: boolean;
  /** Hide the app's windows from screenshots and screen sharing (where the OS allows). */
  hideFromCapture: boolean;
}

const DEFAULTS: DesktopPreferences = { closeToTray: false, hideFromCapture: false };

function preferencesFilePath(): string {
  return path.join(app.getPath('userData'), 'desktop-preferences.json');
}

/** Never throws: a missing or corrupt file is the default (close quits, as before). */
export function getDesktopPreferences(): DesktopPreferences {
  try {
    const parsed: unknown = JSON.parse(readFileSync(preferencesFilePath(), 'utf-8'));
    if (typeof parsed !== 'object' || parsed === null) return DEFAULTS;
    const { closeToTray, hideFromCapture } = parsed as Partial<DesktopPreferences>;
    return {
      closeToTray: typeof closeToTray === 'boolean' ? closeToTray : DEFAULTS.closeToTray,
      hideFromCapture:
        typeof hideFromCapture === 'boolean' ? hideFromCapture : DEFAULTS.hideFromCapture,
    };
  } catch {
    return DEFAULTS;
  }
}

/** Errors reach the caller: a setting that silently fails to save is worse than one that
 * says so. */
export function setDesktopPreferences(patch: Partial<DesktopPreferences>): DesktopPreferences {
  const next = { ...getDesktopPreferences(), ...patch };
  writeFileSync(preferencesFilePath(), JSON.stringify(next), 'utf-8');
  return next;
}
