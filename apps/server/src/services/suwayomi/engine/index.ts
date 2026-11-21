import { announceEngineChange } from '../../../utils/libraryChanges.js';
import {
  getSuwayomiSettings,
  notifySuwayomiConnectionChange,
  setBuiltInConnectionProvider,
} from '../settings.js';
import { latestRuntime, latestServerRelease, type RuntimeRelease } from './download.js';
import { installEngine, removeEngine, type InstallProgress } from './install.js';
import {
  MAX_MEMORY_MB,
  MIN_MEMORY_MB,
  enginePaths,
  engineRoot,
  folderSize,
  readRecord,
  writeRecord,
  type InstalledVersions,
} from './layout.js';
import { LICENSES, PINNED_SERVER, runtimePlatform, type ServerRelease } from './manifest.js';
import { engineProcess } from './process.js';

/**
 * The extension engine as the rest of the server sees it: install, update, start, stop
 * and remove, one download at a time, and a status for Settings.
 */

export type EngineStatusState =
  'not-installed' | 'downloading' | 'stopped' | 'starting' | 'running' | 'error';

export interface EngineUpdateOffer {
  server: string;
  runtime: string;
}

export interface EngineStatus {
  state: EngineStatusState;
  /** Whether this computer has a Java runtime build at all. */
  supported: boolean;
  installed: InstalledVersions | null;
  download: InstallProgress | null;
  /** Set by "Check for updates" when newer versions exist. */
  update: EngineUpdateOffer | null;
  error: string | null;
  lastLines: string[];
  diskBytes: number;
  memoryMb: number | null;
  startWithServer: boolean | null;
  licenses: typeof LICENSES;
}

let download: { controller: AbortController; progress: InstallProgress | null } | null = null;
let downloadError: string | null = null;
let offer: { server: ServerRelease; runtime: RuntimeRelease } | null = null;

const listeners = new Set<() => void>();

/** Called whenever the status changes (download progress, engine state). */
export function onEngineStatusChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function changed(): void {
  // Open apps and tabs re-read the status (libraryEvents.route.ts).
  announceEngineChange();
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // A listener must never break the engine.
    }
  }
}

setBuiltInConnectionProvider(() => engineProcess.currentConnection());
engineProcess.onChange(() => {
  notifySuwayomiConnectionChange();
  changed();
});

export async function engineStatus(): Promise<EngineStatus> {
  const record = readRecord();
  const runtime = engineProcess.status();
  const state: EngineStatusState = download
    ? 'downloading'
    : !record
      ? 'not-installed'
      : runtime.state;
  return {
    state,
    supported: runtimePlatform() !== null,
    installed: record?.active ?? null,
    download: download?.progress ?? null,
    update:
      offer && record ? { server: offer.server.version, runtime: offer.runtime.version } : null,
    error: downloadError ?? runtime.error,
    lastLines: runtime.state === 'error' ? runtime.lastLines : [],
    diskBytes: await folderSize(engineRoot()),
    memoryMb: record?.memoryMb ?? null,
    startWithServer: record?.startWithServer ?? null,
    licenses: LICENSES,
  };
}

export class EngineBusyError extends Error {
  constructor() {
    super('The extension engine is already downloading');
    this.name = 'EngineBusyError';
  }
}

/** Starts a download (install or update) in the background; one at a time. */
function runDownload(
  options: { server?: ServerRelease; runtime?: RuntimeRelease },
  afterwards: () => Promise<void>,
): void {
  if (download) throw new EngineBusyError();
  const controller = new AbortController();
  download = { controller, progress: null };
  downloadError = null;
  changed();
  void (async () => {
    try {
      await installEngine({
        ...options,
        signal: controller.signal,
        onProgress: (progress) => {
          if (download) download.progress = progress;
          changed();
        },
      });
      offer = null;
      download = null;
      changed();
      await afterwards();
    } catch (error) {
      download = null;
      downloadError = controller.signal.aborted ? null : (error as Error).message;
      changed();
    }
  })();
}

/** Downloads and installs the pinned engine. */
export function installBuiltInEngine(): void {
  runDownload({ server: PINNED_SERVER }, async () => {
    if (getSuwayomiSettings()?.mode === 'built-in') await engineProcess.start();
  });
}

/** Installs the versions "Check for updates" offered, then restarts on them. */
export function updateBuiltInEngine(): void {
  if (!offer) throw new Error('Check for updates first');
  const { server, runtime } = offer;
  runDownload({ server, runtime }, async () => {
    if (engineProcess.status().state !== 'stopped') {
      await engineProcess.stop();
      await engineProcess.start();
    }
  });
}

export function cancelEngineDownload(): boolean {
  if (!download) return false;
  download.controller.abort();
  return true;
}

/** Compares the installed versions with the latest releases. Never installs anything. */
export async function checkEngineUpdates(): Promise<EngineUpdateOffer | null> {
  const record = readRecord();
  const platform = runtimePlatform();
  if (!record || !platform) return null;
  const [server, runtime] = await Promise.all([latestServerRelease(), latestRuntime(platform)]);
  offer =
    server.version !== record.active.server || runtime.version !== record.active.runtime
      ? { server, runtime }
      : null;
  changed();
  return offer ? { server: server.version, runtime: runtime.version } : null;
}

export async function startBuiltInEngine(): Promise<void> {
  if (!readRecord()) throw new Error('The extension engine is not installed');
  await engineProcess.start();
}

export async function stopBuiltInEngine(): Promise<void> {
  await engineProcess.stop();
}

export async function removeBuiltInEngine(options: { keepData: boolean }): Promise<void> {
  cancelEngineDownload();
  await engineProcess.stop();
  await removeEngine(options);
  offer = null;
  downloadError = null;
  changed();
}

export async function updateEngineSettings(settings: {
  memoryMb?: number;
  startWithServer?: boolean;
}): Promise<void> {
  const record = readRecord();
  if (!record) throw new Error('The extension engine is not installed');
  const memoryMb = settings.memoryMb ?? record.memoryMb;
  if (!Number.isInteger(memoryMb) || memoryMb < MIN_MEMORY_MB || memoryMb > MAX_MEMORY_MB) {
    throw new Error(`The memory limit must be ${MIN_MEMORY_MB}-${MAX_MEMORY_MB} MB`);
  }
  await writeRecord({
    ...record,
    memoryMb,
    startWithServer: settings.startWithServer ?? record.startWithServer,
  });
  changed();
}

/** At server start: runs the engine when it is chosen, installed and set to start. */
export function bootBuiltInEngine(): void {
  if (getSuwayomiSettings()?.mode !== 'built-in') return;
  const record = readRecord();
  if (!record?.startWithServer) return;
  void engineProcess.start().catch((error: Error) => {
    console.warn('[Engine] Did not start:', error.message);
  });
}

/** At server shutdown: stops the engine before the server exits. */
export async function shutdownBuiltInEngine(): Promise<void> {
  cancelEngineDownload();
  await engineProcess.stop();
}

/** Last resort on process exit, when nothing can be awaited. */
export function killBuiltInEngineNow(): void {
  engineProcess.killNow();
}

export { enginePaths };
