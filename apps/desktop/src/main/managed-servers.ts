/**
 * Starting the bundled API and web app, when this build is responsible for them, and
 * saying how that went. The one place that knows the order: decide whether to manage,
 * find the bundle, spawn, publish the chosen addresses, then follow readiness.
 *
 * Electron-free on purpose. Everything it needs from the app (paths, the spawner, where
 * progress is reported) is passed in, so the sequence runs under `node --test` with fakes
 * (tests/managed-servers.cjs) and index.ts only wires it to the real ones.
 */
import path from 'node:path';
import {
  buildLocalWebUrl,
  LOCAL_API_BASE_URL,
  setManagedServerUrls,
  type ManagedServerUrls,
} from '../shared/config';
import {
  resolveServerPaths as realResolveServerPaths,
  shouldManageServers as realShouldManageServers,
  startServers as realStartServers,
} from './servers';

/**
 * How this launch's servers came to be.
 * - `unmanaged`: not this app's to start (development, or no bundle found). Whatever is
 *   already running at the configured addresses is used.
 * - `managed`: started here, on the addresses given. They may still be booting; `ready`
 *   settles when both accept connections.
 * - `failed`: this app should have started them and could not. Told apart from
 *   `unmanaged` so the diagnostic report does not describe a broken install as a
 *   development setup.
 */
export type ManagedStart =
  | { kind: 'unmanaged' }
  | ({
      kind: 'managed';
      /** What the renderer's api-client should use. */
      apiBaseUrl: string;
      ready: Promise<void>;
    } & ManagedServerUrls)
  | { kind: 'failed'; error: unknown };

export interface ManagedStartDeps {
  isPackaged: boolean;
  /** `app.getAppPath()`: apps/desktop in a monorepo run. */
  appPath: string;
  resourcesPath: string;
  /** `app.getPath('userData')`: writable without elevation, and kept across updates. */
  userDataDir: string;
  /** The API's encryption key for stored credentials. May throw; that is not fatal. */
  resolveTokenKey: () => string | undefined;
  /** The renderer's "starting" screen follows these (main/init-state.ts). */
  onApiStarting: () => void;
  onApiReady: () => void;
  onApiFailed: () => void;
  /** For the diagnostic report (main/diagnostics.ts). */
  recordStartupError: (stage: 'servers-start' | 'servers-ready', error: unknown) => void;
  /** Replaced by fakes under test; the real ones otherwise. */
  shouldManageServers?: typeof realShouldManageServers;
  resolveServerPaths?: typeof realResolveServerPaths;
  startServers?: typeof realStartServers;
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Never rejects: a failure is an outcome, since the window still opens (onto its own
 * "can't connect" screen) and the reader can still reach the diagnostic report.
 */
export async function startManagedServers(deps: ManagedStartDeps): Promise<ManagedStart> {
  const shouldManage = deps.shouldManageServers ?? realShouldManageServers;
  const resolvePaths = deps.resolveServerPaths ?? realResolveServerPaths;
  const start = deps.startServers ?? realStartServers;

  if (!shouldManage(deps.isPackaged)) return { kind: 'unmanaged' };

  // The app path is apps/desktop in a monorepo run; the repo root is two up.
  const appRoot = path.join(deps.appPath, '..', '..');
  const paths = resolvePaths(deps.resourcesPath, appRoot);
  if (!paths) {
    console.warn(
      '[main] Managed servers requested but no bundled API/web build was found — falling back to whatever is already running.',
    );
    return { kind: 'unmanaged' };
  }

  let announced = false;
  try {
    // Alongside the desktop's own local cache, in a directory the OS guarantees is
    // writable and preserves across updates.
    const databaseFile = path.join(deps.userDataDir, 'projektmanga.db');
    // Same directory, same reasoning: writable without elevation, and preserved across
    // updates so installed sources survive one.
    const extensionBundlesDir = path.join(deps.userDataDir, 'installed-extensions');
    let tokenEncryptionKey: string | undefined;
    try {
      tokenEncryptionKey = deps.resolveTokenKey();
    } catch (error) {
      // Not fatal: only stored credentials need it, and the server says so when asked.
      console.warn('[main] Could not prepare the server encryption key:', describe(error));
    }

    deps.onApiStarting();
    announced = true;
    const { apiPort, webPort, ready, apiReady } = await start(
      paths,
      databaseFile,
      extensionBundlesDir,
      { tokenEncryptionKey },
    );
    // The window loader, the local-DB seed and main/sync.ts all ask shared/config for
    // these, so they pick up the chosen ports from here on.
    const urls: ManagedServerUrls = {
      webUrl: buildLocalWebUrl(webPort),
      apiUrl: `http://127.0.0.1:${apiPort}/api`,
    };
    setManagedServerUrls(urls);

    apiReady.then(deps.onApiReady, deps.onApiFailed);

    // Not awaited: the window is created immediately and shows its own "Starting…"
    // screen while these boot. Failures still have to be visible, hence the catch.
    ready.catch((error: unknown) => {
      console.error('[main] Bundled servers did not become ready:', describe(error));
      deps.recordStartupError('servers-ready', error);
    });

    return { kind: 'managed', apiBaseUrl: LOCAL_API_BASE_URL, ready, ...urls };
  } catch (error) {
    console.error('[main] Failed to start bundled servers:', describe(error));
    deps.recordStartupError('servers-start', error);
    // The renderer is holding its "starting" screen for an API that is not coming.
    if (announced) deps.onApiFailed();
    return { kind: 'failed', error };
  }
}
