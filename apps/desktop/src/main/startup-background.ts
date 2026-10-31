import { app, BrowserWindow, Menu, Tray } from 'electron';
import { getDesktopPreferences, setDesktopPreferences } from './desktop-preferences';
import { getMainWindow, sendRendererCommand } from './renderer-commands';
import { revealLockIfLocked } from './app-lock';

const BACKGROUND_ARG = '--pm-background-start';
let tray: Tray | null = null;
let enabled = false;
let quitting = false;

export interface StartupBackgroundState {
  supported: boolean;
  enabled: boolean;
}

function supported(): boolean {
  return app.isPackaged && (process.platform === 'win32' || process.platform === 'darwin');
}

function loginSettings() {
  return process.platform === 'win32'
    ? app.getLoginItemSettings({ args: [BACKGROUND_ARG] })
    : app.getLoginItemSettings();
}

function showWindow(): void {
  // While locked, "Open" brings up the PIN prompt, never the app.
  if (revealLockIfLocked()) return;
  const win = getMainWindow() ?? BrowserWindow.getAllWindows()[0];
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

async function ensureTray(): Promise<void> {
  if (tray) return;
  const icon = await app.getFileIcon(process.execPath, { size: 'small' });
  if (icon.isEmpty()) throw new Error('Could not create the background app icon');
  const createdTray = new Tray(icon);
  try {
    createdTray.setToolTip('Projekt Manga');
    createdTray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Projekt Manga', click: showWindow },
        { label: 'Update library', click: () => sendRendererCommand({ type: 'update-library' }) },
        { type: 'separator' },
        { label: 'Quit Projekt Manga', click: () => app.quit() },
      ]),
    );
    createdTray.on('double-click', showWindow);
    tray = createdTray;
  } catch (error) {
    createdTray.destroy();
    throw error;
  }
}

export function getStartupBackgroundState(): StartupBackgroundState {
  return { supported: supported(), enabled: supported() && loginSettings().openAtLogin };
}

export async function setStartupBackground(
  enabledAtLogin: boolean,
): Promise<StartupBackgroundState> {
  if (!supported()) throw new Error('Background startup is unavailable in this build');
  if (enabledAtLogin) await ensureTray();
  app.setLoginItemSettings(
    process.platform === 'win32'
      ? { openAtLogin: enabledAtLogin, args: [BACKGROUND_ARG] }
      : { openAtLogin: enabledAtLogin },
  );
  const state = getStartupBackgroundState();
  if (state.enabled !== enabledAtLogin) {
    if (!state.enabled) {
      tray?.destroy();
      tray = null;
    }
    throw new Error('The operating system did not apply the startup setting');
  }
  enabled = state.enabled;
  if (!enabled) dropTrayIfUnused();
  return state;
}

/** The tray stays while either background startup or close-to-tray needs it. */
function dropTrayIfUnused(): void {
  if (enabled || closeToTray) return;
  tray?.destroy();
  tray = null;
}

/** Where the tray can live. Linux tray support depends on the desktop environment, so
 * it isn't offered there. */
function trayPlatform(): boolean {
  return process.platform === 'win32' || process.platform === 'darwin';
}

let closeToTray = false;

export interface CloseToTrayState {
  supported: boolean;
  enabled: boolean;
}

export function getCloseToTrayState(): CloseToTrayState {
  return { supported: trayPlatform(), enabled: trayPlatform() && closeToTray };
}

/** Settings › Desktop › Close to tray. The tray is created first, so turning this on can
 * never leave a hidden window with no icon to bring it back. */
export async function setCloseToTray(value: boolean): Promise<CloseToTrayState> {
  if (!trayPlatform()) throw new Error('Close to tray is unavailable on this system');
  if (value) await ensureTray();
  setDesktopPreferences({ closeToTray: value });
  closeToTray = value;
  if (!value) dropTrayIfUnused();
  return getCloseToTrayState();
}

/** Called after app.whenReady: restores close-to-tray, creating its tray icon. */
export async function initializeCloseToTray(): Promise<void> {
  if (!trayPlatform() || !getDesktopPreferences().closeToTray) return;
  try {
    await ensureTray();
    closeToTray = true;
  } catch (error) {
    console.warn('[main] Tray unavailable; closing the window will quit:', error);
  }
}

/** Called after app.whenReady, before creating the window. */
export async function initializeStartupBackground(): Promise<boolean> {
  if (!supported()) return false;
  enabled = getStartupBackgroundState().enabled;
  if (!enabled) return false;
  try {
    await ensureTray();
  } catch (error) {
    console.warn('[main] Background tray unavailable; opening the window instead:', error);
    enabled = false;
    return false;
  }
  return process.platform === 'win32'
    ? process.argv.includes(BACKGROUND_ARG)
    : loginSettings().wasOpenedAtLogin;
}

export function shouldHideWindowOnClose(): boolean {
  return (enabled || closeToTray) && !quitting;
}

export function markQuitting(): void {
  quitting = true;
}

export { showWindow as showBackgroundWindow };
