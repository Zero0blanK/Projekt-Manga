import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { encryptToken } from '../../../utils/tokenCrypto.js';
import {
  downloadVerified,
  latestRuntime,
  serverJarUrl,
  type DownloadProgress,
  type RuntimeRelease,
} from './download.js';
import {
  DEFAULT_MEMORY_MB,
  enginePaths,
  engineRoot,
  readRecord,
  writeRecord,
  type EngineRecord,
  type InstalledVersions,
} from './layout.js';
import { PINNED_SERVER, runtimePlatform, type ServerRelease } from './manifest.js';
import { findJava, unpack } from './unpack.js';

/**
 * Installing, updating and removing the extension engine.
 *
 * Everything is downloaded and unpacked in staging/ first. Only a part that passed its
 * checksum and unpacked into the expected layout is moved into place, with one rename, so
 * a failed or cancelled download never touches the engine that works. An update installs
 * new versions beside the old ones; the old ones stay until the new ones have started.
 */

export type InstallStep = 'runtime' | 'server' | 'verifying' | 'unpacking' | 'finishing';

export interface InstallProgress {
  step: InstallStep;
  received: number;
  total: number | null;
}

export interface InstallOptions {
  server?: ServerRelease;
  runtime?: RuntimeRelease;
  signal?: AbortSignal;
  onProgress?: (progress: InstallProgress) => void;
}

async function exists(file: string): Promise<boolean> {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}

/** Moves a staged folder to its place. A folder already there (the same version, from an
 * earlier install) is replaced only after the new one is fully staged. */
async function moveIntoPlace(staged: string, target: string): Promise<void> {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  if (await exists(target)) {
    const old = `${target}.old-${process.pid}`;
    await fsp.rename(target, old);
    await fsp.rename(staged, target);
    await fsp.rm(old, { recursive: true, force: true });
  } else {
    await fsp.rename(staged, target);
  }
}

async function stageRuntime(
  runtime: RuntimeRelease,
  staging: string,
  options: InstallOptions,
): Promise<string> {
  const archive = path.join(staging, `runtime.${runtime.archive}`);
  const unpacked = path.join(staging, 'runtime');
  const report = (step: InstallStep) => (p: DownloadProgress) =>
    options.onProgress?.({ step, received: p.received, total: p.total });
  await downloadVerified(runtime.url, archive, runtime.sha256, {
    size: runtime.size,
    signal: options.signal,
    onProgress: report('runtime'),
  });
  options.onProgress?.({ step: 'unpacking', received: 0, total: null });
  await unpack(archive, unpacked, options.signal);
  await fsp.rm(archive, { force: true });
  if (!(await findJava(unpacked))) throw new Error('The Java runtime has no java executable');
  return unpacked;
}

async function stageServer(
  server: ServerRelease,
  staging: string,
  options: InstallOptions,
): Promise<string> {
  const dir = path.join(staging, 'server');
  await fsp.mkdir(dir, { recursive: true });
  await downloadVerified(
    serverJarUrl(server),
    path.join(dir, 'Suwayomi-Server.jar'),
    server.sha256,
    {
      size: server.size,
      signal: options.signal,
      onProgress: (p) =>
        options.onProgress?.({ step: 'server', received: p.received, total: p.total }),
    },
  );
  return dir;
}

function newLogin(): EngineRecord['login'] {
  return {
    username: 'projektmanga',
    password_encrypted: encryptToken(randomBytes(32).toString('base64url')),
  };
}

/**
 * Installs the engine, or installs newer versions beside the current ones. A part whose
 * version is already installed is not downloaded again.
 */
export async function installEngine(options: InstallOptions = {}): Promise<EngineRecord> {
  const platform = runtimePlatform();
  if (!platform) throw new Error('The extension engine has no Java runtime for this computer');
  const server = options.server ?? PINNED_SERVER;
  const runtime = options.runtime ?? (await latestRuntime(platform, options.signal));
  const target: InstalledVersions = { server: server.version, runtime: runtime.version };

  const staging = enginePaths.stagingDir();
  await fsp.rm(staging, { recursive: true, force: true });
  await fsp.mkdir(staging, { recursive: true });
  try {
    const runtimeDir = enginePaths.runtimeDir(target.runtime);
    const serverDir = enginePaths.serverDir(target.server);
    const haveRuntime = Boolean(await findJava(runtimeDir));
    const haveServer = await exists(enginePaths.serverJar(target.server));
    const stagedRuntime = haveRuntime ? null : await stageRuntime(runtime, staging, options);
    const stagedServer = haveServer ? null : await stageServer(server, staging, options);
    options.signal?.throwIfAborted();
    options.onProgress?.({ step: 'finishing', received: 0, total: null });
    if (stagedRuntime) await moveIntoPlace(stagedRuntime, runtimeDir);
    if (stagedServer) await moveIntoPlace(stagedServer, serverDir);
  } finally {
    await fsp.rm(staging, { recursive: true, force: true });
  }

  const current = readRecord();
  const same =
    current && current.active.server === target.server && current.active.runtime === target.runtime;
  const record: EngineRecord = current
    ? {
        ...current,
        active: target,
        previous: same ? current.previous : current.active,
        unverified: same ? current.unverified : true,
      }
    : {
        active: target,
        previous: null,
        unverified: false,
        login: newLogin(),
        memoryMb: DEFAULT_MEMORY_MB,
        startWithServer: true,
      };
  await writeRecord(record);
  return record;
}

async function removeVersions(versions: InstalledVersions, keep: InstalledVersions | null) {
  if (versions.runtime !== keep?.runtime) {
    await fsp.rm(enginePaths.runtimeDir(versions.runtime), { recursive: true, force: true });
  }
  if (versions.server !== keep?.server) {
    await fsp.rm(enginePaths.serverDir(versions.server), { recursive: true, force: true });
  }
}

/** The new versions started: the previous ones are no longer needed. */
export async function confirmUpdate(): Promise<void> {
  const record = readRecord();
  if (!record?.unverified) return;
  if (record.previous) await removeVersions(record.previous, record.active);
  await writeRecord({ ...record, previous: null, unverified: false });
}

/** The new versions failed to start: go back to the previous ones and drop the new. */
export async function rollBackUpdate(): Promise<boolean> {
  const record = readRecord();
  if (!record?.unverified || !record.previous) return false;
  const failed = record.active;
  await writeRecord({ ...record, active: record.previous, previous: null, unverified: false });
  await removeVersions(failed, record.previous);
  return true;
}

/** Removes the engine. Its data (extensions and their settings) only when asked. */
export async function removeEngine(options: { keepData: boolean }): Promise<void> {
  const root = engineRoot();
  for (const part of ['runtime', 'server', 'staging', 'logs']) {
    await fsp.rm(path.join(root, part), { recursive: true, force: true });
  }
  await fsp.rm(enginePaths.pidFile(), { force: true });
  await writeRecord(null);
  if (!options.keepData) await fsp.rm(enginePaths.dataDir(), { recursive: true, force: true });
}
