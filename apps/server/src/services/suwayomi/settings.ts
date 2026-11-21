import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { suwayomiServerUrlSchema, type SuwayomiSettingsBody } from '@projekt-manga/schemas';
import { decryptToken, encryptToken } from '../../utils/tokenCrypto.js';

/**
 * The host's Suwayomi server connection (Settings › Sources).
 *
 * A host-level setting like the installed extensions, so it is stored beside the database
 * rather than per account, the same way as the source network settings. The password is
 * write-only and encrypted at rest with the tracker-token key; no response carries it.
 */

/**
 * Where Suwayomi sources come from:
 * - `built-in`: the extension engine this server downloads and runs (engine/);
 * - `external`: a Suwayomi server the user runs, at the saved address and login;
 * - `off`: no Suwayomi sources.
 * A file saved before modes existed has none, and reads as `external`.
 */
export type SuwayomiMode = 'built-in' | 'external' | 'off';
const MODES: readonly SuwayomiMode[] = ['built-in', 'external', 'off'];

interface StoredSettings {
  mode: SuwayomiMode;
  enabled: boolean;
  /** The external server's address; kept while another mode is chosen, to switch back. */
  url: string | null;
  username: string | null;
  password_encrypted: string | null;
}

export interface SuwayomiSettingsSummary {
  mode: SuwayomiMode;
  enabled: boolean;
  url: string;
  username: string | null;
  has_password: boolean;
  /** False when a saved password can no longer be decrypted (TOKEN_ENCRYPTION_KEY changed). */
  password_readable: boolean;
}

/** A usable connection, for the API's own requests only. */
export interface SuwayomiConnection {
  /** Origin plus any path prefix, without a trailing slash. */
  baseUrl: string;
  /** A ready `Authorization` header value, when the server has a login. */
  authorization?: string;
}

let overrideFile: string | null = null;
let cached: StoredSettings | null | undefined;

function settingsFile(): string {
  if (overrideFile) return overrideFile;
  const databaseUrl = process.env.DATABASE_URL?.trim() || 'file:./data/projektmanga.db';
  return path.join(path.dirname(path.resolve(databaseUrl.slice('file:'.length))), 'suwayomi.json');
}

export function normalizeBaseUrl(raw: string): string {
  const parsed = new URL(raw);
  return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`;
}

/** Keeps only a well-formed file, so a hand-edited one can never point requests somewhere
 * the endpoint would have refused. */
function sanitize(raw: unknown): StoredSettings | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const mode = MODES.includes(value.mode as SuwayomiMode)
    ? (value.mode as SuwayomiMode)
    : 'external';
  const url = suwayomiServerUrlSchema.safeParse(value.url);
  // An external connection needs its address; the other modes keep one only to go back.
  if (!url.success && mode === 'external') return null;
  return {
    mode,
    enabled: value.enabled === true,
    url: url.success ? normalizeBaseUrl(url.data) : null,
    username:
      typeof value.username === 'string' && value.username && !/[:\r\n]/.test(value.username)
        ? value.username
        : null,
    password_encrypted:
      typeof value.password_encrypted === 'string' && value.password_encrypted
        ? value.password_encrypted
        : null,
  };
}

function readStored(): StoredSettings | null {
  if (cached !== undefined) return cached;
  try {
    cached = sanitize(JSON.parse(fs.readFileSync(settingsFile(), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[Suwayomi] Ignoring unreadable settings file');
    }
    cached = null;
  }
  return cached;
}

function readPassword(stored: StoredSettings): { password?: string; readable: boolean } {
  if (!stored.password_encrypted) return { readable: true };
  try {
    return { password: decryptToken(stored.password_encrypted), readable: true };
  } catch {
    return { readable: false };
  }
}

function summarize(stored: StoredSettings): SuwayomiSettingsSummary {
  return {
    mode: stored.mode,
    enabled: stored.enabled,
    url: stored.url ?? '',
    username: stored.username,
    has_password: stored.password_encrypted !== null,
    password_readable: readPassword(stored).readable,
  };
}

const listeners = new Set<() => void>();

/** Called whenever the connection changes, so cached source lists are dropped. */
export function onSuwayomiSettingsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function writeStored(next: StoredSettings | null): Promise<void> {
  const file = settingsFile();
  if (next === null) {
    await fsp.rm(file, { force: true });
  } else {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    // Written whole and renamed into place, so a crash never leaves a half-written file.
    const temporary = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
    await fsp.rename(temporary, file);
  }
  cached = next;
  for (const listener of listeners) listener();
}

export function getSuwayomiSettings(): SuwayomiSettingsSummary | null {
  const stored = readStored();
  return stored ? summarize(stored) : null;
}

export async function saveSuwayomiSettings(
  body: SuwayomiSettingsBody,
): Promise<SuwayomiSettingsSummary> {
  const previous = readStored();
  const url = normalizeBaseUrl(body.url);
  const username = body.username?.trim() || null;
  let password_encrypted = previous?.password_encrypted ?? null;
  if (body.clear_password || !username) password_encrypted = null;
  // A saved password belongs to the server it was entered for; never send it to a new one.
  if (previous && previous.url !== url) password_encrypted = null;
  if (body.password && username) password_encrypted = encryptToken(body.password);
  // Saving the external form chooses the external server.
  const next: StoredSettings = {
    mode: 'external',
    enabled: body.enabled,
    url,
    username,
    password_encrypted,
  };
  await writeStored(next);
  return summarize(next);
}

/** Chooses where Suwayomi sources come from, keeping the external server's details. */
export async function setSuwayomiMode(mode: SuwayomiMode): Promise<SuwayomiSettingsSummary> {
  const previous = readStored();
  const next: StoredSettings = previous
    ? { ...previous, mode }
    : { mode, enabled: mode !== 'off', url: null, username: null, password_encrypted: null };
  if (mode === 'external' && !next.url) {
    throw new Error('Save the Suwayomi server address first');
  }
  await writeStored(next);
  return summarize(next);
}

/** Announces that the built-in engine's connection changed (it started or stopped), so
 * cached source lists are dropped like after a settings change. */
export function notifySuwayomiConnectionChange(): void {
  for (const listener of listeners) listener();
}

let builtInConnection: () => SuwayomiConnection | null = () => null;

/** The engine registers how to reach it while it runs (engine/index.ts). */
export function setBuiltInConnectionProvider(provider: () => SuwayomiConnection | null): void {
  builtInConnection = provider;
}

export async function removeSuwayomiSettings(): Promise<void> {
  await writeStored(null);
}

/** The connection the API uses, or null when none is saved or it is turned off. */
export function readSuwayomiConnection(): SuwayomiConnection | null {
  const stored = readStored();
  if (stored?.mode === 'built-in') return builtInConnection();
  if (!stored?.enabled || stored.mode !== 'external' || !stored.url) return null;
  const { password } = readPassword(stored);
  const authorization =
    stored.username && password !== undefined
      ? `Basic ${Buffer.from(`${stored.username}:${password}`, 'utf8').toString('base64')}`
      : undefined;
  return { baseUrl: stored.url, ...(authorization ? { authorization } : {}) };
}

/** Test seam: points the store at a temp file and drops the in-memory copy. */
export function setSuwayomiSettingsFileForTests(file: string | null): void {
  overrideFile = file;
  cached = undefined;
}
