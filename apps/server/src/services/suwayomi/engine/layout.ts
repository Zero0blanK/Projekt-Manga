import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * Where the extension engine lives, and the record of what is installed.
 *
 * Everything is in `suwayomi-engine/` beside the database, which on desktop is the app's
 * user-data folder:
 *   runtime/<version>/   the Java runtime
 *   server/<version>/    Suwayomi-Server's jar
 *   data/                the engine's own data: its extensions, their settings, server.conf
 *   staging/             downloads in progress; nothing in it is ever used to run
 *   logs/engine.log      the engine's output
 *   engine.json          what is installed (below)
 */

export interface InstalledVersions {
  server: string;
  runtime: string;
}

export interface EngineRecord {
  /** The versions the engine runs. */
  active: InstalledVersions;
  /** The versions before the last update, kept until the new ones have started once. */
  previous: InstalledVersions | null;
  /** Set by an update; cleared once the engine has started on the new versions. */
  unverified: boolean;
  /** The engine's generated login, the password encrypted with tokenCrypto. */
  login: { username: string; password_encrypted: string };
  /** Java heap limit, in MB. */
  memoryMb: number;
  /** Start the engine when the server starts. */
  startWithServer: boolean;
}

export const DEFAULT_MEMORY_MB = 512;
export const MIN_MEMORY_MB = 256;
export const MAX_MEMORY_MB = 8192;

let overrideRoot: string | null = null;

/** The engine folder, beside the database. */
export function engineRoot(): string {
  if (overrideRoot) return overrideRoot;
  const databaseUrl = process.env.DATABASE_URL?.trim() || 'file:./data/projektmanga.db';
  const databaseDir = path.dirname(path.resolve(databaseUrl.slice('file:'.length)));
  return path.join(databaseDir, 'suwayomi-engine');
}

/** Test seam: puts the engine folder somewhere disposable. */
export function setEngineRootForTests(root: string | null): void {
  overrideRoot = root;
}

export const enginePaths = {
  runtimeDir: (version: string) => path.join(engineRoot(), 'runtime', safeName(version)),
  serverDir: (version: string) => path.join(engineRoot(), 'server', safeName(version)),
  serverJar: (version: string) =>
    path.join(engineRoot(), 'server', safeName(version), 'Suwayomi-Server.jar'),
  dataDir: () => path.join(engineRoot(), 'data'),
  stagingDir: () => path.join(engineRoot(), 'staging'),
  logsDir: () => path.join(engineRoot(), 'logs'),
  logFile: () => path.join(engineRoot(), 'logs', 'engine.log'),
  pidFile: () => path.join(engineRoot(), 'engine.pid'),
  recordFile: () => path.join(engineRoot(), 'engine.json'),
};

/** A version as a folder name: only the characters a release tag uses. */
export function safeName(version: string): string {
  if (!/^[\w.+-]{1,64}$/.test(version) || version === '.' || version === '..') {
    throw new Error(`Not a version: ${JSON.stringify(version)}`);
  }
  return version;
}

function isVersions(value: unknown): value is InstalledVersions {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.server === 'string' && typeof v.runtime === 'string';
}

/** Reads engine.json, keeping only a well-formed record. */
export function readRecord(): EngineRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(enginePaths.recordFile(), 'utf8'));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const login = r.login as Record<string, unknown> | undefined;
  if (
    !isVersions(r.active) ||
    !login ||
    typeof login.username !== 'string' ||
    typeof login.password_encrypted !== 'string'
  ) {
    return null;
  }
  const memory = Number(r.memoryMb);
  return {
    active: r.active,
    previous: isVersions(r.previous) ? r.previous : null,
    unverified: r.unverified === true,
    login: { username: login.username, password_encrypted: login.password_encrypted },
    memoryMb:
      Number.isInteger(memory) && memory >= MIN_MEMORY_MB && memory <= MAX_MEMORY_MB
        ? memory
        : DEFAULT_MEMORY_MB,
    startWithServer: r.startWithServer !== false,
  };
}

/** Writes engine.json whole and renames it into place, so a crash never leaves half. */
export async function writeRecord(record: EngineRecord | null): Promise<void> {
  const file = enginePaths.recordFile();
  if (record === null) {
    await fsp.rm(file, { force: true });
    return;
  }
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, JSON.stringify(record, null, 2), { mode: 0o600 });
  await fsp.rename(temporary, file);
}

/** Total size of a folder, for "disk use". Missing folders count as 0. */
export async function folderSize(dir: string): Promise<number> {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await folderSize(full);
    else if (entry.isFile()) total += (await fsp.stat(full)).size;
  }
  return total;
}
