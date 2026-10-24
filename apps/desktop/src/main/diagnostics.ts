/**
 * Environment facts only the main process can see, for the diagnostic report.
 *
 * The renderer assembles the actual report (apps/web/src/lib/diagnostics.ts) — this side
 * supplies what a web page cannot know: real OS and runtime versions, the local cache's
 * schema state, and what the supervised child processes printed.
 *
 * Every field is chosen explicitly. In particular this returns **no paths at all**: the
 * database path, the userData directory and the app root all contain the user's account
 * name on every platform, and nothing about them helps triage a bug.
 */
import os from 'node:os';
import { app } from 'electron';
import { getDb } from './db/connection';
import { readLog } from './log-buffer';

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
  managedServers: boolean;
  logs: { api: string[]; web: string[]; main: string[] };
}

/** Highest applied migration in the local cache, or null if the table can't be read —
 * which is itself the interesting signal when the database is the problem. */
function readLocalDbVersion(): { version: number | null; ok: boolean } {
  try {
    const row = getDb().prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as
      { version: number | null } | undefined;
    return { version: row?.version ?? null, ok: true };
  } catch {
    return { version: null, ok: false };
  }
}

export function collectDiagnostics(managedServers: boolean): DesktopDiagnostics {
  const { version, ok } = readLocalDbVersion();

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
    managedServers,
    logs: {
      api: readLog('api'),
      web: readLog('web'),
      main: readLog('main'),
    },
  };
}
