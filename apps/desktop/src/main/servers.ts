/**
 * Supervises the API and web-app processes the installer ships with.
 *
 * In dev, both are started by hand (`npm run dev:server`, `npm run dev:web`) and Electron
 * is only a window onto them. A packaged installer has no one to do that, so the main
 * process becomes their parent: it picks free ports, starts them, waits for them, and
 * kills them on exit.
 *
 * Supervision is on when packaged and off in dev. `PROJEKT_MANGA_MANAGED_SERVERS` forces
 * it either way, to exercise the packaged path without packaging.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { LOCAL_API_BASE_URL } from '../shared/config';
import { appendLog } from './log-buffer';

export interface RunningServers {
  apiPort: number;
  webPort: number;
  /** Resolves when both servers accept connections; rejects on timeout. Deliberately
   * not awaited before the window is created: ports are known once the children spawn, so
   * the window can load its final URL right away and show a "Starting…" screen
   * (`loadWebApp` in window.ts retries) instead of no window during a first-run migration. */
  ready: Promise<void>;
}

/** How long to wait for each server to answer before giving up. Generous because a first
 * run also pays for schema migration and Next's initial compile. */
const READY_TIMEOUT_MS = 90_000;
const READY_POLL_MS = 500;

/** Loopback only. The web server is reached through `projektmanga.localhost`, which
 * resolves here; the API is reached only through the web server's rewrite proxy. Neither
 * has any reason to be visible on the LAN. */
const BIND_HOST = '127.0.0.1';

let apiProcess: ChildProcess | null = null;
let webProcess: ChildProcess | null = null;

/**
 * Asks the OS for an unused port by binding to 0 and reading back what it assigned.
 *
 * Inherently racy (the port could be taken before the child binds it), but a fixed port
 * fails every time something else owns 3000 or 4000. Probed on the same host the child
 * will bind, since a port can be free on loopback and taken on another interface.
 */
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, BIND_HOST, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('Could not determine a free port')));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

/** Whether this process should start the servers itself. */
export function shouldManageServers(isPackaged: boolean): boolean {
  const override = process.env.PROJEKT_MANGA_MANAGED_SERVERS?.trim().toLowerCase();
  if (override === '1' || override === 'true') return true;
  if (override === '0' || override === 'false') return false;
  return isPackaged;
}

interface ServerPaths {
  /** Entry script for the API. */
  apiEntry: string;
  /** Directory containing the built Next app (its `.next` and `package.json`). */
  webDir: string;
  /** Next's CLI entry. */
  nextEntry: string;
  /**
   * A real Node runtime shipped beside the app, or null to fall back to Electron's own.
   *
   * The API child needs Node >= 25 or the extension sandbox refuses to start — see
   * `spawnNode`. Null in a monorepo run, where the developer's own `node` on PATH is not
   * what `process.execPath` points at anyway; there the check in the sandbox is the
   * backstop.
   */
  nodeBinary: string | null;
}

/** The staged runtime's filename, as `stage-node-runtime.mjs` copies it. */
const BUNDLED_NODE = process.platform === 'win32' ? 'node.exe' : 'node';

/**
 * Locates the bundled server and web app.
 *
 * Packaged builds place them under `resources/` (see electron-builder.yml's
 * `extraResources`); an unpackaged run finds them in the monorepo. Returns null when
 * neither is present, which is the signal to fall back to "assume the user started them".
 */
export function resolveServerPaths(resourcesPath: string, appRoot: string): ServerPaths | null {
  const packagedNode = path.join(resourcesPath, 'node', BUNDLED_NODE);
  const candidates = [
    // Packaged layout.
    {
      apiEntry: path.join(resourcesPath, 'server', 'dist', 'server.js'),
      webDir: path.join(resourcesPath, 'web'),
      nextEntry: path.join(resourcesPath, 'web', 'node_modules', 'next', 'dist', 'bin', 'next'),
      nodeBinary: fs.existsSync(packagedNode) ? packagedNode : null,
    },
    // Monorepo layout: apps/desktop -> repo root.
    {
      apiEntry: path.join(appRoot, 'apps', 'server', 'dist', 'server.js'),
      webDir: path.join(appRoot, 'apps', 'web'),
      nextEntry: path.join(appRoot, 'node_modules', 'next', 'dist', 'bin', 'next'),
      nodeBinary: null,
    },
  ];

  const resolved =
    candidates.find((c) => fs.existsSync(c.apiEntry) && fs.existsSync(c.nextEntry)) ?? null;

  // A packaged build missing the runtime would fall back to Electron's Node and silently
  // fail every installed source, with no hint where to look. Warn at startup instead.
  if (resolved && resolved.apiEntry.startsWith(resourcesPath) && resolved.nodeBinary === null) {
    console.warn(
      `[supervisor] No bundled Node runtime at ${packagedNode}. Falling back to Electron's ` +
        'own Node, which is older than the extension sandbox requires — installed sources ' +
        'will fail on first use. The installer should have staged it (see ' +
        'scripts/stage-node-runtime.mjs).',
    );
  }

  return resolved;
}

/**
 * Runs a Node script in a child process.
 *
 * Prefers a real Node runtime shipped beside the app, falling back to Electron's own
 * binary with `ELECTRON_RUN_AS_NODE` (which makes it behave as a plain `node`; without it
 * the child would try to start a second Electron app).
 *
 * The fallback is not equivalent, which is why the installer carries a second runtime.
 * The API child runs the extension sandbox, which refuses to start below Node 25 because
 * `--allow-net` only became a gated permission there; on older versions, omitting the flag
 * restricts nothing and a "sandboxed" source would have full network access. Electron's
 * bundled Node is older than that, so on the fallback path every installed source fails
 * on first use. See scripts/stage-node-runtime.mjs.
 *
 * The web child has no such requirement and simply uses whichever is available.
 */
function spawnNode(
  entry: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  channel: 'api' | 'web',
  nodeBinary: string | null,
): ChildProcess {
  const useBundled = nodeBinary !== null;
  const child = spawn(useBundled ? nodeBinary : process.execPath, [entry, ...args], {
    cwd,
    // ELECTRON_RUN_AS_NODE means nothing to a real node binary, but leaving it set would
    // be inherited by anything the child spawns in turn — including the sandbox's own
    // children — so it is only applied on the path that actually needs it.
    env: useBundled
      ? { ...process.env, ...env, ELECTRON_RUN_AS_NODE: undefined }
      : { ...process.env, ...env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout?.on('data', (data: Buffer) => appendLog(channel, data.toString()));
  child.stderr?.on('data', (data: Buffer) => appendLog(channel, data.toString()));
  child.on('exit', (code, signal) => {
    appendLog(channel, `[supervisor] process exited (code=${code}, signal=${signal})`);
  });

  return child;
}

/** Resolves once the port accepts a TCP connection, or rejects on timeout. A TCP probe
 * rather than an HTTP one because it makes no assumption about which paths exist or what
 * status they return while still proving the listener is up. */
async function waitForPort(port: number, label: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ port, host: BIND_HOST });
      const done = (result: boolean) => {
        socket.destroy();
        resolve(result);
      };
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
      socket.setTimeout(READY_POLL_MS, () => done(false));
    });

    if (open) return;
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }

  throw new Error(`${label} did not start listening on port ${port} within ${READY_TIMEOUT_MS}ms`);
}

/**
 * Starts both servers on freshly-chosen ports and waits until they accept connections.
 *
 * The API port is passed to the web server as `PROJEKT_MANGA_API_PORT`, which
 * apps/web's `src/proxy.ts` reads per request — that indirection is what keeps the port out
 * of the browser bundle entirely. Deliberately not `next.config.ts`'s `rewrites()`, which is
 * evaluated during `next build` and would bake this build machine's port into the packaged
 * app; see the note in next.config.ts.
 */
export async function startServers(
  paths: ServerPaths,
  databaseFile: string,
  extensionBundlesDir: string,
): Promise<RunningServers> {
  const [apiPort, webPort] = await Promise.all([findFreePort(), findFreePort()]);

  apiProcess = spawnNode(
    paths.apiEntry,
    [],
    path.dirname(path.dirname(paths.apiEntry)),
    {
      SERVER_PORT: String(apiPort),
      SERVER_HOST: BIND_HOST,
      NODE_ENV: 'production',
      // The database lives in the user's app-data directory, not next to the binary:
      // Program Files is not writable, and a database inside the install directory would
      // be destroyed by the next update.
      DATABASE_URL: `file:${databaseFile}`,
      // Same reasons as the database. Without this the server falls back to
      // `<cwd>/data/installed-extensions` (extensionRepository.service.ts's
      // `resolveBundlesDir`), and the API child's cwd is the staged server inside the
      // install directory: updates would wipe installed sources, and a per-machine install
      // (not writable) could not install any. Sources must outlive app updates.
      EXTENSION_BUNDLES_DIR: extensionBundlesDir,
      // The server applies pending migrations itself, behind a backup it restores on
      // failure (apps/server/src/configs/migrate.ts). This is the server's default; it is
      // set explicitly so a user environment carrying PROJEKT_MANGA_AUTO_MIGRATE=0 can't
      // turn it off for the installer.
      PROJEKT_MANGA_AUTO_MIGRATE: '1',
    },
    'api',
    paths.nodeBinary,
  );

  webProcess = spawnNode(
    paths.nextEntry,
    ['start', '--hostname', BIND_HOST, '--port', String(webPort)],
    paths.webDir,
    {
      PROJEKT_MANGA_API_PORT: String(apiPort),
      // `next start` re-evaluates next.config.ts at boot, so this has to be set at run
      // time and not only at build time. Leaving it out lets the runtime config take the
      // non-single-origin branch — different image patterns and no rewrite — while the
      // client bundle still emits relative URLs, which shows up as covers 400ing.
      NEXT_PUBLIC_API_URL: LOCAL_API_BASE_URL,
      NODE_ENV: 'production',
    },
    'web',
    paths.nodeBinary,
  );

  // Waited for in parallel: the web server does not need the API to boot, and serialising
  // them would add the API's start-up time to every launch for no benefit.
  const ready = Promise.all([
    waitForPort(apiPort, 'API server'),
    waitForPort(webPort, 'Web server'),
  ]).then(() => undefined);

  return { apiPort, webPort, ready };
}

/**
 * Kills both children, and on Windows their descendants too.
 *
 * Called from `will-quit`. Without it they outlive Electron, and the API in particular has
 * children of its own: every installed source runs as a forked sandbox process
 * (apps/extensions/sandbox/spawnSandboxedSource.ts).
 *
 * The platform split is load-bearing rather than defensive. On POSIX, SIGTERM reaches the
 * API's own handler, which calls `disposeAllSandboxedSources` before exiting — the clean
 * path. Windows has no signals: `child.kill()` maps to TerminateProcess, so that handler
 * never runs and the forked scrapers are simply orphaned, left running after the app has
 * closed. `taskkill /T` walks the tree instead.
 *
 * Synchronous on purpose: Electron does not await `will-quit` listeners, so anything
 * asynchronous here would be abandoned half-done.
 */
export function stopServers(): void {
  for (const child of [webProcess, apiProcess]) {
    if (!child || child.exitCode !== null || child.killed || child.pid === undefined) continue;

    if (process.platform === 'win32') {
      const result = spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
      });
      // Fall back rather than leaving the process alive if taskkill is unavailable —
      // killing the parent alone still beats killing nothing.
      if (result.error) child.kill();
    } else {
      child.kill();
    }
  }
  webProcess = null;
  apiProcess = null;
}
