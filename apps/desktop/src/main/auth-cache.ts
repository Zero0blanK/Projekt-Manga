/**
 * Offline identity cache: lets the main process know "which account owns this local DB"
 * without a network round-trip, so desktop's local-first data stays usable (and correctly
 * scoped for sync) even with no server reachable at all.
 *
 * Uses Electron's built-in safeStorage (DPAPI/Keychain/libsecret depending on OS) rather
 * than a new dependency — no password or password hash is ever cached here, only an
 * opaque session token, and the trust boundary is explicitly the OS user account (same
 * threat model as a browser's saved-password store).
 */
import { safeStorage, app } from 'electron';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';

export interface CachedSession {
  user_id: string;
  email: string;
  device_id: string;
  session_id: string;
  cached_at: string;
}

function cacheFilePath(): string {
  return path.join(app.getPath('userData'), 'auth.enc');
}

function isCachedSession(value: unknown): value is CachedSession {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<CachedSession>;
  return (
    typeof v.user_id === 'string' &&
    typeof v.email === 'string' &&
    typeof v.device_id === 'string' &&
    typeof v.session_id === 'string' &&
    typeof v.cached_at === 'string'
  );
}

/** The decrypted session, kept so the many callers (every DB open, IPC call and sync step)
 * don't each re-read and re-decrypt the file. Only ever holds a successfully parsed session;
 * dropped whenever this module writes or deletes the file. */
let memoized: CachedSession | null = null;

export function getCachedSession(): CachedSession | null {
  const filePath = cacheFilePath();
  if (!existsSync(filePath) || !safeStorage.isEncryptionAvailable()) {
    memoized = null;
    return null;
  }
  if (memoized) return { ...memoized };

  try {
    const encrypted = readFileSync(filePath);
    const decrypted = safeStorage.decryptString(encrypted);
    const parsed: unknown = JSON.parse(decrypted);
    // Shape-checked rather than cast: a blob written by an older build with a different
    // field set decrypts and parses fine, and the cast would then hand sync.ts a
    // `session_id` of undefined — which it would dutifully format into the request as
    // `pm_session=undefined` and get a confusing 401 for, instead of the "not logged in"
    // this function is supposed to report.
    if (!isCachedSession(parsed)) return null;
    memoized = parsed;
    return { ...parsed };
  } catch {
    // Corrupt or undecryptable (e.g. OS keychain reset) — treat as "not logged in"
    // rather than crashing the app on startup.
    return null;
  }
}

export function setCachedSession(session: CachedSession): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS-level credential encryption is not available on this machine');
  }
  memoized = null;
  const encrypted = safeStorage.encryptString(JSON.stringify(session));
  // 0600: the blob is already OS-encrypted and bound to this user account, so this is
  // belt-and-braces — but the default (0644 after a typical umask) leaves a session token
  // world-readable on a shared POSIX machine, and there's no reason to hand it out.
  writeFileSync(cacheFilePath(), encrypted, { mode: 0o600 });
}

export function clearCachedSession(): void {
  memoized = null;
  const filePath = cacheFilePath();
  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }
}
