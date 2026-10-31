import fs from 'fs/promises';
import path from 'path';
import { BACKUP_FILE_NAME_PATTERN } from '@projekt-manga/schemas';
import type { BackupConfig, BackupFileInfo } from '@projekt-manga/types';

/**
 * Where automatic backups live on disk, and nothing else.
 *
 * Every file here is a full copy of someone's reading history, so the layout is kept
 * deliberately narrow: one folder per owner (`anonymous` or a user id) under the server's
 * data directory, and only names this module generated are ever read back. Callers never
 * hand it a path — just an owner and, at most, a file name that must match
 * BACKUP_FILE_NAME_PATTERN.
 */

const DEFAULT_INTERVAL_HOURS = 24;
const DEFAULT_KEEP = 7;
const OWNER_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** Read on each call rather than captured at import: tests point it at a temp folder, and
 * the server's working directory is only final once startup has run. */
export const backupRoot = (): string =>
  path.resolve(process.env.BACKUP_DIR?.trim() || path.join(process.cwd(), 'data', 'backups'));

const configFile = () => path.join(backupRoot(), 'config.json');

export const ownerKey = (userId?: string | null): string => userId ?? 'anonymous';

export const ownerDir = (owner: string): string => {
  // User ids are cuids, so anything else is a bug or an attack, never a real owner.
  if (!OWNER_PATTERN.test(owner)) throw new Error('Invalid backup owner');
  return path.join(backupRoot(), owner);
};

const fileFor = (owner: string, name: string): string => {
  if (!BACKUP_FILE_NAME_PATTERN.test(name)) throw new Error('Invalid backup file name');
  return path.join(ownerDir(owner), name);
};

const intFromEnv = (raw: string | undefined, fallback: number, min: number): number => {
  const value = Number(raw);
  return raw?.trim() && Number.isInteger(value) && value >= min ? value : fallback;
};

/** Env supplies the defaults; the admin endpoint's overrides are stored beside the backups
 * so they survive a restart without anyone editing `.env`. */
export const readBackupConfig = async (): Promise<BackupConfig> => {
  const config: BackupConfig = {
    intervalHours: intFromEnv(process.env.BACKUP_INTERVAL_HOURS, DEFAULT_INTERVAL_HOURS, 0),
    keep: intFromEnv(process.env.BACKUP_KEEP, DEFAULT_KEEP, 1),
  };
  try {
    const stored = JSON.parse(await fs.readFile(configFile(), 'utf8')) as Partial<BackupConfig>;
    if (Number.isInteger(stored.intervalHours) && stored.intervalHours! >= 0) {
      config.intervalHours = stored.intervalHours!;
    }
    if (Number.isInteger(stored.keep) && stored.keep! >= 1) config.keep = stored.keep!;
  } catch (error) {
    // A missing file is the normal case; a corrupt one falls back to the env defaults
    // rather than stopping backups altogether.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[Backups] Ignoring unreadable backup config:', (error as Error).message);
    }
  }
  return config;
};

export const writeBackupConfig = async (config: BackupConfig): Promise<void> => {
  await fs.mkdir(backupRoot(), { recursive: true });
  await fs.writeFile(configFile(), JSON.stringify(config, null, 2));
};

/** `2026-10-28T12:30:00.000Z` → `2026-10-28T12-30-00-000Z`: sortable and legal on Windows. */
const stamp = (date: Date) => date.toISOString().replace(/[:.]/g, '-');
const unstamp = (name: string): string | null => {
  const match = /^projektmanga-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.json$/.exec(
    name,
  );
  return match ? `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z` : null;
};

/** Newest first. Unrecognised files are ignored, never listed or served. */
export const listBackups = async (owner: string): Promise<BackupFileInfo[]> => {
  let names: string[];
  try {
    names = await fs.readdir(ownerDir(owner));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const files = await Promise.all(
    names
      .filter((name) => BACKUP_FILE_NAME_PATTERN.test(name))
      .map(async (name) => {
        const stat = await fs.stat(fileFor(owner, name)).catch(() => null);
        if (!stat?.isFile()) return null;
        return {
          name,
          createdAt: unstamp(name) ?? stat.mtime.toISOString(),
          size: stat.size,
        };
      }),
  );
  return files
    .filter((file): file is BackupFileInfo => file !== null)
    .sort((a, b) => b.name.localeCompare(a.name));
};

/**
 * Writes one backup and returns its listing entry.
 *
 * Written to a temporary name and renamed, so a crash mid-write never leaves a truncated
 * file that looks like a valid backup in the list.
 */
export const writeBackup = async (
  owner: string,
  contents: string,
  now = new Date(),
): Promise<BackupFileInfo> => {
  const dir = ownerDir(owner);
  await fs.mkdir(dir, { recursive: true });
  const name = `projektmanga-${stamp(now)}.json`;
  const target = fileFor(owner, name);
  const temp = `${target}.tmp`;
  await fs.writeFile(temp, contents, { flag: 'w' });
  await fs.rename(temp, target);
  return { name, createdAt: now.toISOString(), size: Buffer.byteLength(contents) };
};

export const readBackup = async (owner: string, name: string): Promise<string> =>
  await fs.readFile(fileFor(owner, name), 'utf8');

/** Deletes all but the newest `keep` backups for one owner; returns the names removed. */
export const pruneBackups = async (owner: string, keep: number): Promise<string[]> => {
  const stale = (await listBackups(owner)).slice(Math.max(1, keep));
  for (const file of stale) await fs.rm(fileFor(owner, file.name), { force: true });
  return stale.map((file) => file.name);
};

/** Account deletion: the backups are that account's history and must go with it. */
export const removeOwnerBackups = async (owner: string): Promise<void> => {
  await fs.rm(ownerDir(owner), { recursive: true, force: true });
};
