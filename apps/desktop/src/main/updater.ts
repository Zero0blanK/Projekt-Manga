/**
 * Self-update against GitHub Releases.
 *
 * The feed and differential-download machinery are configured in electron-builder.yml's
 * `publish` block, which makes the build emit `latest.yml` (the feed) and `.exe.blockmap`
 * (the per-block diff) alongside the installer.
 *
 * Four constraints here are easy to undo by accident:
 *
 * - **Nothing downloads or installs unless the user asks.** A new version only raises the prompt;
 *   `autoDownload` and `autoInstallOnAppQuit` stay off, so quitting never applies an update.
 * - **Everything is gated on `app.isPackaged`.** electron-updater has no `app-update.yml` in a dev
 *   run and throws on the first call, so an ungated check would make `npm run dev:desktop` fail on
 *   startup for a feature that cannot work there anyway.
 * - **A failed check must never be fatal.** It runs during startup; a network error, a rate limit
 *   or a repository with no releases yet all have to degrade to "no update" and leave the app
 *   running. Every entry point below either resolves or records the failure in state.
 * - **Every event is mirrored into `appendLog('main', …)`.** That is what puts update history into
 *   the existing "Copy diagnostic report" output (apps/web/src/lib/diagnostics.ts already includes
 *   the main log), so a user reporting "it won't update" ships the reason with the report.
 */
import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import { appendLog } from './log-buffer';
import { getUpdatePreferences, setSkippedVersion } from './update-preferences';

export type UpdateStatus =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'up-to-date'
  | 'error';

export interface UpdateState {
  /** False in a dev run, where there is no update feed to check. The UI hides itself on this
   * rather than offering a button that can only fail. */
  supported: boolean;
  status: UpdateStatus;
  currentVersion: string;
  /** The version on offer, once one is known. */
  availableVersion: string | null;
  /** 0-100 while downloading, else null. */
  downloadPercent: number | null;
  /** Last failure, in the user's words rather than a stack trace. */
  error: string | null;
  /** What changed in the version on offer, as plain text (from the GitHub release notes). */
  releaseNotes: string | null;
  /** True when the launch prompt should be shown for the version on offer: not skipped, and
   * not put off with "Later" during this run. */
  prompt: boolean;
}

let state: UpdateState = {
  supported: false,
  status: 'unsupported',
  currentVersion: app.getVersion(),
  availableVersion: null,
  downloadPercent: null,
  error: null,
  releaseNotes: null,
  prompt: false,
};

/** How often a running app looks for a release, since it can stay up in the tray for days. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** The version "Later" was chosen for during this run; a newer one still gets asked about. */
let dismissedVersion: string | null = null;
/** "Update now" was chosen before the download finished: restart as soon as it does. */
let installWhenDownloaded = false;

/**
 * GitHub hands the release notes over as HTML (or, for multi-release feeds, a list of them).
 * The prompt shows plain text, so nothing from the release body is ever rendered as markup.
 */
export function releaseNotesToText(notes: unknown): string | null {
  const html = Array.isArray(notes)
    ? notes
        .map((entry) =>
          typeof entry === 'object' && entry !== null && 'note' in entry
            ? String((entry as { note: unknown }).note ?? '')
            : '',
        )
        .join('\n\n')
    : typeof notes === 'string'
      ? notes
      : '';
  const text = html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '\n• ')
    .replace(/<\s*\/(p|div|h[1-6]|ul|ol)\s*>/gi, '\n')
    .replace(/<\s*(p|h[1-6])(\s[^>]*)?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text || null;
}

function shouldPrompt(version: string): boolean {
  return dismissedVersion !== version && getUpdatePreferences().skippedVersion !== version;
}

function log(message: string): void {
  appendLog('main', `[updater] ${message}`);
}

function patch(next: Partial<UpdateState>): void {
  state = { ...state, ...next };
}

/**
 * Whether the failure means "this build has no update feed" rather than "the check failed".
 *
 * `app-update.yml` is written into the app's resources only for a real installer target, so a
 * `--dir` build (`npm run package:fast`) has none. electron-updater surfaces that as a bare ENOENT, which is not
 * something to show as an error: nothing is broken, this copy simply cannot self-update.
 */
function isMissingFeed(raw: string): boolean {
  return /app-update\.yml/i.test(raw);
}

/**
 * Turns whatever electron-updater threw into one sentence.
 *
 * Its errors carry full URLs, absolute paths and occasionally response bodies. The status line in
 * Settings is not the place for any of those — an absolute path in particular carries the user's
 * name and the build machine's layout. The untruncated text still reaches the diagnostic report
 * through `log`, which is where it is actually useful.
 */
function describeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|network/i.test(raw)) {
    return 'Could not reach GitHub to check for updates.';
  }
  if (/404|No published versions|Cannot find latest\.yml/i.test(raw)) {
    return 'No published releases to update to yet.';
  }
  if (/rate limit/i.test(raw)) {
    return 'GitHub rate-limited the update check. Try again later.';
  }
  return raw
    .split('\n')[0]
    .replace(/[A-Za-z]:\\[^\s'"]+/g, '<path>')
    .replace(/\/(?:home|Users)\/[^\s'"]+/g, '<path>')
    .slice(0, 200);
}

/** Shared by the event handler and the direct-throw path, which do not both fire for every
 * failure — a malformed feed URL throws from the call and never reaches the 'error' event. */
function recordFailure(error: unknown, context: string): void {
  const raw = error instanceof Error ? error.message : String(error);
  if (isMissingFeed(raw)) {
    patch({ supported: false, status: 'unsupported', downloadPercent: null, error: null });
    log('this build has no update feed (app-update.yml absent) — self-update is unavailable');
    return;
  }
  installWhenDownloaded = false;
  // A failed download leaves the version on offer, so the prompt can show why and retry.
  patch({
    status: state.availableVersion ? 'available' : 'error',
    downloadPercent: null,
    error: describeError(error),
  });
  log(`${context}: ${raw}`);
}

/**
 * Wires the updater up. Safe to call once, from `whenReady`.
 *
 * Does not check for anything by itself — `checkForUpdates()` is a separate call so startup can
 * fire it without blocking, and the Settings button can reuse the same path.
 */
export function initUpdater(): void {
  if (!app.isPackaged) {
    patch({ supported: false, status: 'unsupported' });
    return;
  }

  patch({ supported: true, status: 'idle' });

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  // Routed into the same buffer as everything else rather than left on its default console
  // logger, so internal detail (which URL, which version, why a check failed) lands in the
  // diagnostic report instead of a terminal nobody is watching.
  autoUpdater.logger = {
    info: (m: unknown) => log(`info: ${String(m)}`),
    warn: (m: unknown) => log(`warn: ${String(m)}`),
    error: (m: unknown) => log(`error: ${String(m)}`),
    debug: () => {},
  };

  autoUpdater.on('checking-for-update', () => {
    patch({ status: 'checking', error: null });
    log('checking for updates');
  });

  autoUpdater.on('update-available', (info) => {
    patch({
      status: 'available',
      availableVersion: info.version,
      downloadPercent: null,
      releaseNotes: releaseNotesToText(info.releaseNotes),
      prompt: shouldPrompt(info.version),
    });
    log(`update available: ${info.version}`);
  });

  autoUpdater.on('update-not-available', () => {
    patch({ status: 'up-to-date', availableVersion: null, downloadPercent: null });
    log('already up to date');
  });

  autoUpdater.on('download-progress', (progress) => {
    patch({ status: 'downloading', downloadPercent: Math.round(progress.percent) });
  });

  autoUpdater.on('update-downloaded', (info) => {
    patch({
      status: 'downloaded',
      availableVersion: info.version,
      downloadPercent: 100,
      releaseNotes: releaseNotesToText(info.releaseNotes) ?? state.releaseNotes,
    });
    log(`update downloaded: ${info.version}`);
    if (installWhenDownloaded) installNow();
  });

  autoUpdater.on('error', (error) => recordFailure(error, 'failed'));
}

/** Resolves once the check has been *started and settled*; never rejects. */
export async function checkForUpdates(): Promise<UpdateState> {
  if (!state.supported) return state;
  // A new check would reset a download under way, or one waiting to be installed.
  if (state.status === 'downloading' || state.status === 'downloaded') return state;
  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    // Also reported through the 'error' event in most cases, but not all of them — a throw from
    // the call itself (a malformed feed URL, say) never reaches that handler.
    recordFailure(error, 'check threw');
  }
  return state;
}

/** Keeps looking while the app stays open. Leaves a prompt on screen undisturbed. */
export function startPeriodicUpdateChecks(): void {
  if (!state.supported) return;
  setInterval(() => {
    if (!state.prompt) void checkForUpdates();
  }, CHECK_INTERVAL_MS).unref();
}

/** Starts downloading the update on offer. */
export async function downloadUpdate(): Promise<UpdateState> {
  if (!state.supported || state.status !== 'available') return state;
  try {
    patch({ status: 'downloading', downloadPercent: 0, error: null });
    await autoUpdater.downloadUpdate();
  } catch (error) {
    recordFailure(error, 'download threw');
  }
  return state;
}

/**
 * Quits and installs now.
 *
 * The quit is what makes this safe rather than the install: `app.on('will-quit', stopServers)` in
 * index.ts force-kills the supervised children first, and one of them *is* `resources/node/node.exe`
 * — a file the installer has to overwrite. Windows will not replace a running executable, so if
 * that teardown ever stops happening before this point, updates start failing with a file-in-use
 * error rather than anything that names the real cause.
 */
export function installNow(): void {
  if (!state.supported || state.status !== 'downloaded') return;
  log('restarting to install');
  autoUpdater.quitAndInstall();
}

/**
 * "Update now" from the launch prompt. Restarts straight away when the update is already
 * downloaded; otherwise starts (or keeps) the download and restarts when it lands.
 */
export async function updateNow(): Promise<UpdateState> {
  if (!state.supported) return state;
  if (state.status === 'downloaded') {
    installNow();
    return state;
  }
  installWhenDownloaded = true;
  log('update now requested');
  if (state.status === 'available') return downloadUpdate();
  return state;
}

/**
 * "Later" or "Skip this version" from the prompt. "Later" asks again on the next launch; "Skip"
 * stays quiet until a newer version is published. Settings → About can still install either.
 */
export function dismissUpdatePrompt(choice: 'later' | 'skip'): UpdateState {
  dismissedVersion = state.availableVersion;
  installWhenDownloaded = false;
  if (choice === 'skip' && state.availableVersion) {
    setSkippedVersion(state.availableVersion);
  }
  patch({ prompt: false });
  log(`launch prompt dismissed (${choice}) for ${state.availableVersion ?? 'unknown version'}`);
  return state;
}

export function getUpdateState(): UpdateState {
  return state;
}
