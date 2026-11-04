/**
 * Main-process IPC handlers — the privileged operations the preload bridge exposes to
 * the renderer. Every handler here must treat its arguments as untrusted input: they
 * arrive from the renderer's JS context, which per Electron's own security model is
 * assumed compromisable even though in practice it's just our own Next.js app.
 */
import {
  app,
  BrowserWindow,
  ipcMain,
  nativeImage,
  shell,
  clipboard,
  session as electronSession,
  type IpcMainInvokeEvent,
} from 'electron';
import {
  DESKTOP_CHANNELS,
  resolveApiUrl,
  resolveWebUrl,
  SESSION_COOKIE_NAME,
} from '../shared/config';
import { localStore, type LocalChapterStub } from './db/local-store';
import { getCachedSession, setCachedSession, clearCachedSession } from './auth-cache';
import { cancelActiveSync, runSync } from './sync';
import { collectDiagnostics } from './diagnostics';
import { getInitState } from './init-state';
import { requireSecureAccountTransport } from './secure-transport';
import {
  checkForUpdates,
  downloadUpdate,
  getUpdateState,
  installNow,
  updateNow,
  dismissUpdatePrompt,
} from './updater';
import {
  getCloseToTrayState,
  getStartupBackgroundState,
  setCloseToTray,
  setStartupBackground,
} from './startup-background';
import { registerLocalArchiveHandlers } from './local-archives';
import { resolveOpenableFolder } from './openable-folder';
import { sessionCookieOrigins } from './session-cookie-origins';
import { openSourceBrowser } from './source-browser';
import { clearAppLock, getAppLockState, isAppLocked, lockApp, setAppLock } from './app-lock';
import { getDesktopPreferences } from './desktop-preferences';
import { setHideFromCapture } from './window';
import { parseOpenBrowserArgs } from './source-browser-policy';

function requireMainAppFrame(event: IpcMainInvokeEvent): void {
  if (
    // A top-level app window only: not a <webview>, DevTools or other hosted contents.
    BrowserWindow.fromWebContents(event.sender)?.webContents !== event.sender ||
    event.senderFrame !== event.sender.mainFrame ||
    new URL(event.sender.getURL()).origin !== new URL(resolveWebUrl()).origin
  ) {
    throw new Error('This setting is available only from the app window');
  }
  // While the app lock is on, a page left running in a hidden window gets nothing.
  if (isAppLocked()) throw new Error('The app is locked');
}

/** `ipcMain.handle` that refuses any caller outside the app's own main frame. Every
 * channel goes through this so no handler can forget the check. */
function handleFromApp(
  channel: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown,
): void {
  ipcMain.handle(channel, (event, ...args) => {
    requireMainAppFrame(event);
    return listener(event, ...args);
  });
}

async function rendererSessionCookie(event: IpcMainInvokeEvent): Promise<string | null> {
  const pageUrl = event.sender.getURL();
  for (const origin of sessionCookieOrigins(resolveApiUrl(), pageUrl || undefined)) {
    const cookies = await electronSession.defaultSession.cookies.get({
      url: origin,
      name: SESSION_COOKIE_NAME,
    });
    if (cookies[0]) return cookies[0].value;
  }
  return null;
}

/** { success, message, data } — the same envelope shape packages/api-client already
 * expects from the HTTP path, so the runtime branch (packages/api-client/src/runtime.ts)
 * doesn't need a second response shape to unwrap. */
interface InvokeEnvelope<T> {
  success: boolean;
  message: string;
  data?: T;
}

function ok<T>(data: T, message = 'OK'): InvokeEnvelope<T> {
  return { success: true, message, data };
}

/** `undefined` when absent, the string when present, an error otherwise. */
function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  return value;
}

/** Same, but the column is nullable, so an explicit null is meaningful and preserved. */
function nullableString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  return value;
}

/** A non-empty string id. Ids are bound into queries and URLs, so an empty or non-string
 * value is rejected here rather than reaching the store. */
function requiredId(value: unknown, message: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(message);
  return value;
}

/** A non-negative, finite count. Rejects NaN/Infinity, which bind as-is and would poison
 * the running `time_read + ?` total. */
function optionalCount(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a non-negative number`);
  }
  return value;
}

/** A bounded, non-empty string naming part of a chapter's key. */
function keyPart(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    throw new Error(`${field} must be a non-empty string of at most 512 characters`);
  }
  return value;
}

function optionalFinite(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  return value;
}

/** The chapter a mark names — the source's key within its title — plus the catalog
 * fields used if this device has to stand a row up for it. Every field is bound into
 * SQL, so each is checked rather than the object being cast across. */
function chapterStub(value: unknown): LocalChapterStub {
  if (!value || typeof value !== 'object') throw new Error('chapter is required');
  const c = value as Record<string, unknown>;
  return {
    source: keyPart(c.source, 'chapter.source'),
    manga_slug: keyPart(c.manga_slug, 'chapter.manga_slug'),
    source_chapter_key: keyPart(c.source_chapter_key, 'chapter.source_chapter_key'),
    chapter_number: optionalFinite(c.chapter_number, 'chapter.chapter_number'),
    name: nullableString(c.name, 'chapter.name'),
    url: nullableString(c.url, 'chapter.url'),
    page_count: optionalCount(c.page_count, 'chapter.page_count') ?? null,
    manga_id: nullableString(c.manga_id, 'chapter.manga_id'),
  };
}

/** Dispatches one {domain, op, args} local-DB call. Every arm treats `args` as untrusted
 * renderer input — this is the sandboxed IPC boundary, same posture as openPath below. */
async function dispatchDataInvoke(
  domain: unknown,
  op: unknown,
  args: unknown,
): Promise<InvokeEnvelope<unknown>> {
  if (typeof domain !== 'string' || typeof op !== 'string') {
    throw new Error('Invalid IPC call: domain and op must be strings');
  }
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;

  // Whether the renderer keeps library data here or uses the server directly. Signed in or
  // not, it uses the server, like every browser that opens the same library, so the app
  // and the browser always show one library and see each other's reading as it happens.
  // A signed-in account's older local changes still reach the server through sync.
  if (domain === 'meta' && op === 'mode') {
    return ok({ localFirst: false });
  }
  if (domain === 'manga' && op === 'listLibrary') {
    return ok(localStore.listLibrary());
  }
  if (domain === 'manga' && op === 'getDetails') {
    return ok(localStore.getMangaDetails(requiredId(a.mangaId, 'mangaId is required')));
  }
  // Called by packages/api-client right after a manga is added over HTTP. The library list
  // is served from the local database, so without this write-back the new title stays
  // invisible until the next startup seed (see syncMangaFromServer).
  if (domain === 'manga' && op === 'syncOne') {
    // Only the add-to-library mirror calls this, so it is an explicit add.
    return ok(
      await localStore.syncMangaFromServer(
        resolveApiUrl(),
        requiredId(a.mangaId, 'mangaId is required'),
        undefined,
        'add',
      ),
    );
  }
  if (domain === 'manga' && op === 'setInLibrary') {
    if (typeof a.inLibrary !== 'boolean') throw new Error('mangaId and inLibrary are required');
    localStore.setMangaInLibrary(
      requiredId(a.mangaId, 'mangaId and inLibrary are required'),
      a.inLibrary,
    );
    return ok(null);
  }
  if (domain === 'chapter' && op === 'markRead') {
    if (typeof a.isRead !== 'boolean') throw new Error('chapter and isRead are required');
    localStore.markChapterRead(chapterStub(a.chapter), a.isRead);
    return ok(null);
  }
  if (domain === 'chapter' && op === 'updateProgress') {
    const stub = chapterStub(a.chapter);
    if (
      typeof a.lastPageRead !== 'number' ||
      !Number.isFinite(a.lastPageRead) ||
      a.lastPageRead < 0
    ) {
      throw new Error('chapter and lastPageRead are required');
    }
    localStore.updateChapterProgress(stub, a.lastPageRead);
    return ok(null);
  }
  if (domain === 'history' && op === 'list') {
    return ok(localStore.listHistory());
  }
  if (domain === 'history' && op === 'delete') {
    if (typeof a.id !== 'string' || a.id.length === 0 || a.id.length > 128) {
      throw new Error('A valid history id is required');
    }
    localStore.deleteHistory(a.id);
    return ok(null);
  }
  if (domain === 'history' && op === 'add') {
    if (typeof a.source !== 'string' || typeof a.manga_slug !== 'string') {
      throw new Error('source and manga_slug are required');
    }
    // Every remaining field is bound straight into an INSERT. Casting the whole `args`
    // object across instead would let a wrong-typed field (an object where a number is
    // expected) reach node:sqlite's binder, which rejects anything outside
    // null/number/bigint/string/Uint8Array — a thrown binder error rather than the
    // "invalid input" this boundary is supposed to produce.
    return ok(
      localStore.addHistory({
        source: a.source,
        manga_slug: a.manga_slug,
        source_manga_id: nullableString(a.source_manga_id, 'source_manga_id'),
        id: optionalString(a.id, 'id'),
        manga_id: nullableString(a.manga_id, 'manga_id'),
        title: nullableString(a.title, 'title'),
        thumbnail_url: nullableString(a.thumbnail_url, 'thumbnail_url'),
        source_chapter_key:
          a.source_chapter_key === undefined || a.source_chapter_key === null
            ? null
            : keyPart(a.source_chapter_key, 'source_chapter_key'),
        pages_read: optionalCount(a.pages_read, 'pages_read'),
        time_read: optionalCount(a.time_read, 'time_read'),
      }),
    );
  }
  if (domain === 'sync' && op === 'seed') {
    return ok(await localStore.seedFromServer(resolveApiUrl()));
  }
  if (domain === 'sync' && op === 'reconcileRestore') {
    if (a.userId !== (getCachedSession()?.user_id ?? null)) {
      throw new Error('Desktop account does not match the restored server library');
    }
    if (a.mode !== undefined && a.mode !== 'merge' && a.mode !== 'replace')
      throw new Error('Invalid restore mode');
    return ok(
      await localStore.reconcileRestoreFromServer(
        resolveApiUrl(),
        a.mode === 'merge' ? 'merge' : 'replace',
      ),
    );
  }
  if (domain === 'sync' && op === 'run') {
    return ok(await runSync(resolveApiUrl()));
  }

  throw new Error(`Unknown IPC call: ${domain}.${op}`);
}

/** A 32-pixel badge PNG as a data URL is a few kilobytes; nothing near this is a badge. */
const BADGE_IMAGE_MAX_LENGTH = 32_768;

export function registerIpcHandlers(
  options: { managedServers: boolean } = { managedServers: false },
): void {
  registerLocalArchiveHandlers(async (event) => {
    requireMainAppFrame(event);
    const cookie = await rendererSessionCookie(event);
    const cached = getCachedSession();
    if (cookie !== (cached?.session_id ?? null))
      throw new Error('Local comics are waiting for the current account session');
    return async () => {
      requireMainAppFrame(event);
      const currentCookie = await rendererSessionCookie(event);
      const current = getCachedSession();
      if (
        currentCookie !== cookie ||
        current?.user_id !== cached?.user_id ||
        current?.session_id !== cached?.session_id
      )
        throw new Error('The account changed. Please try again.');
    };
  });
  handleFromApp(DESKTOP_CHANNELS.startupBackgroundGet, async () => ok(getStartupBackgroundState()));
  // `{ sourceId }` only: the site to load and the hosts whose cookies are kept come from
  // the server's install record, never from the renderer. Malformed input throws before
  // anything opens; a failure after that (not installed, remote server) is a failed
  // envelope the page can show.
  handleFromApp(DESKTOP_CHANNELS.sourceOpenBrowser, async (_event, args: unknown) => {
    const { sourceId, closeWhenPassed } = parseOpenBrowserArgs(args);
    try {
      return ok(await openSourceBrowser(sourceId, { closeWhenPassed }));
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Could not open the source browser',
      };
    }
  });
  // Acts on the window that asked, never on another: the renderer names no window.
  handleFromApp(DESKTOP_CHANNELS.windowGetAlwaysOnTop, (event) =>
    ok(BrowserWindow.fromWebContents(event.sender)?.isAlwaysOnTop() ?? false),
  );
  handleFromApp(DESKTOP_CHANNELS.windowSetAlwaysOnTop, (event, value: unknown) => {
    if (typeof value !== 'boolean') throw new Error('alwaysOnTop must be a boolean');
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) throw new Error('No window to keep on top');
    win.setAlwaysOnTop(value);
    return ok(win.isAlwaysOnTop());
  });
  handleFromApp(DESKTOP_CHANNELS.windowSetProgress, (event, value: unknown) => {
    if (value !== null && (typeof value !== 'number' || !Number.isFinite(value)))
      throw new Error('progress must be a number from 0 to 1, or null');
    const win = BrowserWindow.fromWebContents(event.sender);
    // -1 removes the bar; Electron reads anything above 1 as "indeterminate".
    win?.setProgressBar(value === null ? -1 : Math.min(1, Math.max(0, value)));
    return ok(null);
  });
  handleFromApp(DESKTOP_CHANNELS.windowSetBadge, (event, input: unknown) => {
    const { count, image } = (input ?? {}) as { count?: unknown; image?: unknown };
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0 || count > 9999)
      throw new Error('badge count must be a whole number from 0 to 9999');
    const win = BrowserWindow.fromWebContents(event.sender);
    if (process.platform === 'win32') {
      if (count === 0) {
        win?.setOverlayIcon(null, '');
        return ok(null);
      }
      // Windows has no numeric badge: the page draws one. Only a small PNG is taken, and
      // only as an image; anything else leaves the button as it is.
      if (
        typeof image !== 'string' ||
        image.length > BADGE_IMAGE_MAX_LENGTH ||
        !image.startsWith('data:image/png;base64,')
      )
        throw new Error('badge image must be a small PNG');
      const icon = nativeImage.createFromDataURL(image);
      const size = icon.getSize();
      if (icon.isEmpty() || size.width > 64 || size.height > 64)
        throw new Error('badge image must be a small PNG');
      win?.setOverlayIcon(icon, `${count} ${count === 1 ? 'title' : 'titles'} with new chapters`);
      return ok(null);
    }
    // macOS dock and Linux launchers show the number themselves.
    app.setBadgeCount(count);
    return ok(null);
  });
  handleFromApp(DESKTOP_CHANNELS.lockGetState, () => ok(getAppLockState()));
  handleFromApp(DESKTOP_CHANNELS.lockSet, async (_event, input: unknown) => {
    try {
      return ok(await setAppLock(input));
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : 'Not saved' };
    }
  });
  handleFromApp(DESKTOP_CHANNELS.lockClear, async (_event, input: unknown) => {
    try {
      return ok(await clearAppLock(input));
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : 'Not saved' };
    }
  });
  handleFromApp(DESKTOP_CHANNELS.lockNow, () => {
    lockApp();
    return ok(getAppLockState());
  });
  handleFromApp(DESKTOP_CHANNELS.captureGet, () => ok(getDesktopPreferences().hideFromCapture));
  handleFromApp(DESKTOP_CHANNELS.captureSet, (_event, value: unknown) => {
    if (typeof value !== 'boolean') throw new Error('enabled must be a boolean');
    return ok(setHideFromCapture(value));
  });
  handleFromApp(DESKTOP_CHANNELS.closeToTrayGet, () => ok(getCloseToTrayState()));
  handleFromApp(DESKTOP_CHANNELS.closeToTraySet, async (_event, value: unknown) => {
    if (typeof value !== 'boolean') throw new Error('enabled must be a boolean');
    return ok(await setCloseToTray(value));
  });
  handleFromApp(DESKTOP_CHANNELS.startupBackgroundSet, async (_event, value: unknown) => {
    if (typeof value !== 'boolean') throw new Error('enabled must be a boolean');
    return ok(await setStartupBackground(value));
  });
  // Returns only what main/diagnostics.ts explicitly allowlists — no paths, no config, no
  // secrets. Takes no arguments, so there is no renderer input to validate here.
  handleFromApp(DESKTOP_CHANNELS.diagnosticsCollect, async () =>
    collectDiagnostics(options.managedServers),
  );

  // Writes text to the OS clipboard. Unlike navigator.clipboard this does not require the
  // page to be focused — see the note on DESKTOP_CHANNELS.clipboardWrite.
  handleFromApp(DESKTOP_CHANNELS.clipboardWrite, async (_event, text: unknown) => {
    if (typeof text !== 'string') {
      throw new Error('Clipboard text must be a string');
    }
    clipboard.writeText(text);
    return ok(null);
  });

  // Read by the boot splash while it is up. Argument-free and read-only, so there is no
  // renderer input to validate.
  handleFromApp(DESKTOP_CHANNELS.initGetState, async () => ok(getInitState()));

  // Self-update. Every one of these resolves with the current UpdateState rather than throwing,
  // because the caller is a settings panel that has to render *something* — including when the
  // check failed, which is exactly when the user is looking at it.
  handleFromApp(DESKTOP_CHANNELS.updateGetState, async () => ok(getUpdateState()));
  handleFromApp(DESKTOP_CHANNELS.updateCheck, async () => ok(await checkForUpdates()));
  handleFromApp(DESKTOP_CHANNELS.updateDownload, async () => ok(await downloadUpdate()));
  handleFromApp(DESKTOP_CHANNELS.updateInstallNow, async () => {
    installNow();
    return ok(null);
  });
  handleFromApp(DESKTOP_CHANNELS.updateNow, async () => ok(await updateNow()));
  handleFromApp(DESKTOP_CHANNELS.updateDismiss, async (_event, choice: unknown) => {
    if (choice !== 'later' && choice !== 'skip') {
      throw new Error('choice must be "later" or "skip"');
    }
    return ok(dismissUpdatePrompt(choice));
  });

  // Reveals a folder in the OS file manager — the desktop-only half of "open download
  // folder" (open-folder-button.tsx copies the path to the clipboard instead when this
  // bridge isn't present, e.g. running in a plain browser).
  //
  // `shell.openPath` rather than `shell.showItemInFolder`: every path this is ever called
  // with is a *directory* (the root download folder, or one chapter's download folder),
  // and the reader wants to see what's *inside* it. `showItemInFolder` instead opens the
  // parent directory with the target selected — right for revealing a single file, wrong
  // for "open this folder".
  //
  // `shell.openPath` can *run* executables and remote UNC paths, so only an existing local
  // directory is accepted (resolveOpenableFolder), and only from the app window. The
  // download directory can still be anywhere on a local disk, which is why there is no
  // containment check against one subtree.
  handleFromApp(DESKTOP_CHANNELS.openPath, async (_event, rawPath: unknown) => {
    const target = await resolveOpenableFolder(rawPath);
    // Resolves to an empty string on success, or a human-readable OS error message
    // otherwise — shell.openPath never rejects, so this is the only signal available.
    const error = await shell.openPath(target);
    if (error) {
      throw new Error(error);
    }
    return { ok: true };
  });

  ipcMain.handle(
    DESKTOP_CHANNELS.dataInvoke,
    async (event, domain: unknown, op: unknown, args: unknown) => {
      try {
        // Inside the try so a refused caller gets the same failure envelope as any other
        // rejected call rather than a thrown IPC error.
        requireMainAppFrame(event);
        const browserSession = await rendererSessionCookie(event);
        if (browserSession && browserSession !== getCachedSession()?.session_id) {
          throw new Error('Local data is waiting for the current account session');
        }
        return await dispatchDataInvoke(domain, op, args);
      } catch (error) {
        return {
          success: false,
          message: error instanceof Error ? error.message : 'Local DB call failed',
        };
      }
    },
  );

  handleFromApp(DESKTOP_CHANNELS.authClearCachedSession, async () => {
    cancelActiveSync();
    clearCachedSession();
    return ok(null);
  });

  // The renderer calls this right after a successful register/login with the {user_id,
  // email} the HTTP response already gave it — never the session id itself, since the
  // cookie is httpOnly and the renderer's own JS can't read it. This handler is what
  // actually reads it: Electron's cookie-store API isn't subject to the httpOnly-from-
  // page-JS restriction (that only blocks `document.cookie` inside the page), so the main
  // process can pull the real value straight out of the session the renderer's own
  // fetch() calls already populated it into.
  handleFromApp(DESKTOP_CHANNELS.authSyncCachedSession, async (event, args: unknown) => {
    const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
    if (typeof a.user_id !== 'string' || a.user_id === '' || typeof a.email !== 'string') {
      throw new Error('user_id and email are required');
    }

    const sessionCookie = await rendererSessionCookie(event);
    if (!sessionCookie) throw new Error('No account session cookie was found');

    const apiUrl = resolveApiUrl();
    requireSecureAccountTransport(apiUrl);
    const response = await fetch(`${apiUrl}/auth/me`, {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}` },
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error('Could not verify the current account session');
    const envelope = (await response.json()) as {
      data?: { user?: { id?: string; email?: string } | null };
    };
    const verifiedUser = envelope.data?.user;
    if (!verifiedUser?.id || verifiedUser.id !== a.user_id || !verifiedUser.email) {
      throw new Error('Desktop account does not match the server session');
    }
    if ((await rendererSessionCookie(event)) !== sessionCookie) {
      throw new Error('Account changed while the desktop session was being verified');
    }

    const existing = getCachedSession();
    if (existing?.session_id !== sessionCookie) cancelActiveSync();
    setCachedSession({
      user_id: verifiedUser.id,
      email: verifiedUser.email,
      device_id: existing?.device_id ?? '',
      session_id: sessionCookie,
      cached_at: new Date().toISOString(),
    });
    return ok(null);
  });
}
