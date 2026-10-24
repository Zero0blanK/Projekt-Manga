import { app, BrowserWindow, Menu, Tray } from 'electron';

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
  const win = BrowserWindow.getAllWindows()[0];
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
  if (!enabled) {
    tray?.destroy();
    tray = null;
  }
  return state;
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
  return enabled && !quitting;
}

export function markQuitting(): void {
  quitting = true;
}

export { showWindow as showBackgroundWindow };
