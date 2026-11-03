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

interface StoredSettings {
  enabled: boolean;
  url: string;
  username: string | null;
  password_encrypted: string | null;
}

export interface SuwayomiSettingsSummary {
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
  const url = suwayomiServerUrlSchema.safeParse(value.url);
  if (!url.success) return null;
  return {
    enabled: value.enabled === true,
    url: normalizeBaseUrl(url.data),
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
    enabled: stored.enabled,
    url: stored.url,
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
  const next: StoredSettings = { enabled: body.enabled, url, username, password_encrypted };
  await writeStored(next);
  return summarize(next);
}

export async function removeSuwayomiSettings(): Promise<void> {
  await writeStored(null);
}

/** The connection the API uses, or null when none is saved or it is turned off. */
export function readSuwayomiConnection(): SuwayomiConnection | null {
  const stored = readStored();
  if (!stored?.enabled) return null;
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
