/**
 * Environment facts only the main process can see, for the diagnostic report.
 *
 * The renderer assembles the actual report (apps/web/src/lib/diagnostics.ts) — this side
 * supplies what a web page cannot know: real OS and runtime versions, the local cache's
 * schema state, the supervised servers' state, and what the child processes printed.
 *
 * Every field is chosen explicitly. In particular this returns **no paths at all**: the
 * database path, the userData directory and the app root all contain the user's account
 * name on every platform, and nothing about them helps triage a bug. Sizes and counts are
 * computed here so that no path has to cross the IPC boundary to get them.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, screen } from 'electron';
import { getDb } from './db/connection';
import { readLog } from './log-buffer';
import { getServerStatus, type ServerProcessStatus } from './servers';
import { getUpdateState } from './updater';
import { getDesktopPreferences } from './desktop-preferences';
import { getAppLockState } from './app-lock';
import { getCachedSession } from './auth-cache';

/** A failure during start-up, kept for the report after the console has scrolled past. */
export interface StartupError {
  at: string;
  stage: string;
  message: string;
}

const MAX_STARTUP_ERRORS = 20;
const startupErrors: StartupError[] = [];

/** Records a start-up failure for the report. The renderer scrubs the message. */
export function recordStartupError(stage: string, error: unknown): void {
  startupErrors.push({
    at: new Date().toISOString(),
    stage,
    message: error instanceof Error ? (error.stack ?? error.message) : String(error),
  });
  if (startupErrors.length > MAX_STARTUP_ERRORS) startupErrors.shift();
}

export interface DesktopDiagnostics {
  appVersion: string;
  electronVersion: string;
  chromeVersion: string;
  nodeVersion: string;
  platform: string;
  arch: string;
  osRelease: string;
  localDbVersion: number | null;
  localDbMigrationOk: boolean;
  /** Why the local cache could not be opened, when it could not. */
  localDbError: string | null;
  managedServers: boolean;
  packaged: boolean;
  osVersion: string | null;
  locale: string | null;
  uptimeSeconds: { app: number; system: number };
  memory: { systemTotalMb: number; systemFreeMb: number; appProcessesMb: number };
  cpu: { model: string; cores: number } | null;
  processes: Array<{ type: string; memoryMb: number; cpuPercent: number }>;
  gpu: Record<string, string> | null;
  displays: Array<{ width: number; height: number; scaleFactor: number; primary: boolean }>;
  storage: {
    freeGb: number | null;
    totalGb: number | null;
    serverDbMb: number | null;
    localCacheMb: number | null;
    installedSourceBundles: number | null;
  };
  servers: Record<'api' | 'web', ServerProcessStatus> | null;
  update: {
    status: string;
    availableVersion: string | null;
    error: string | null;
  } | null;
  settings: {
    closeToTray: boolean;
    hideFromCapture: boolean;
    appLock: boolean;
    signedIn: boolean;
  } | null;
  startupErrors: StartupError[];
  logs: { api: string[]; web: string[]; main: string[] };
}

/** Highest applied migration in the local cache, or null if the table can't be read —
 * which is itself the interesting signal when the database is the problem. */
function readLocalDbVersion(): { version: number | null; ok: boolean; error: string | null } {
  try {
    const row = getDb().prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as
      { version: number | null } | undefined;
    return { version: row?.version ?? null, ok: true, error: null };
  } catch (error) {
    return {
      version: null,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Each probe may fail on some platform or in some state; the report then lacks that one
 * fact rather than failing as a whole. */
function attempt<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

const toMb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;
const toGb = (bytes: number) => Math.round((bytes / 1024 ** 3) * 10) / 10;

/** Combined size of the files, in MB, or null when none exists. */
function sizeMb(files: string[]): number | null {
  const sizes = files
    .map((file) => attempt(() => fs.statSync(file).size))
    .filter((size): size is number => size !== null);
  return sizes.length === 0 ? null : toMb(sizes.reduce((sum, size) => sum + size, 0));
}

function storageFacts(): DesktopDiagnostics['storage'] {
  const userData = app.getPath('userData');
  const disk = attempt(() => fs.statfsSync(userData));
  const localCaches =
    attempt(() =>
      fs.readdirSync(userData).filter((name) => /^local(-.+)?\.db(-wal)?$/.test(name)),
    ) ?? [];
  const bundles = attempt(
    () =>
      fs
        .readdirSync(path.join(userData, 'installed-extensions'), { recursive: true })
        .filter((name) => String(name).endsWith('.js')).length,
  );
  return {
    freeGb: disk ? toGb(disk.bavail * disk.bsize) : null,
    totalGb: disk ? toGb(disk.blocks * disk.bsize) : null,
    serverDbMb: sizeMb(
      ['projektmanga.db', 'projektmanga.db-wal'].map((f) => path.join(userData, f)),
    ),
    localCacheMb: sizeMb(localCaches.map((name) => path.join(userData, name))),
    installedSourceBundles: bundles,
  };
}

export function collectDiagnostics(managedServers: boolean): DesktopDiagnostics {
  const { version, ok, error } = readLocalDbVersion();
  const metrics = attempt(() => app.getAppMetrics()) ?? [];
  const update = attempt(() => getUpdateState());
  const preferences = attempt(() => getDesktopPreferences());
  // workingSetSize is reported in kilobytes.
  const processMb = (kb: number) => toMb(kb * 1024);

  return {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    chromeVersion: process.versions.chrome,
    nodeVersion: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    // Kernel/build string — e.g. "10.0.26200". Not the machine name, which os.hostname()
    // would be and which is frequently the user's own name.
    osRelease: os.release(),
    localDbVersion: version,
    localDbMigrationOk: ok,
    localDbError: error,
    managedServers,
    packaged: app.isPackaged,
    // The edition, e.g. "Windows 11 Pro".
    osVersion: attempt(() => os.version()),
    locale: attempt(() => app.getLocale()),
    uptimeSeconds: { app: Math.round(process.uptime()), system: Math.round(os.uptime()) },
    memory: {
      systemTotalMb: toMb(os.totalmem()),
      systemFreeMb: toMb(os.freemem()),
      appProcessesMb: processMb(metrics.reduce((sum, m) => sum + m.memory.workingSetSize, 0)),
    },
    cpu: attempt(() => {
      const cpus = os.cpus();
      return { model: cpus[0]?.model.trim() ?? 'unknown', cores: cpus.length };
    }),
    processes: metrics.map((m) => ({
      type: m.type,
      memoryMb: processMb(m.memory.workingSetSize),
      cpuPercent: Math.round(m.cpu.percentCPUUsage * 10) / 10,
    })),
    gpu: attempt(() => ({ ...app.getGPUFeatureStatus() }) as unknown as Record<string, string>),
    displays:
      attempt(() => {
        const primary = screen.getPrimaryDisplay().id;
        return screen.getAllDisplays().map((display) => ({
          width: display.size.width,
          height: display.size.height,
          scaleFactor: display.scaleFactor,
          primary: display.id === primary,
        }));
      }) ?? [],
    storage: storageFacts(),
    servers: attempt(() => getServerStatus()),
    update: update && {
      status: update.status,
      availableVersion: update.availableVersion,
      error: update.error,
    },
    settings: preferences && {
      closeToTray: preferences.closeToTray,
      hideFromCapture: preferences.hideFromCapture,
      appLock: attempt(() => getAppLockState().enabled) ?? false,
      signedIn: attempt(() => getCachedSession() !== null) ?? false,
    },
    startupErrors: [...startupErrors],
    logs: {
      api: readLog('api'),
      web: readLog('web'),
      main: readLog('main'),
    },
  };
}
