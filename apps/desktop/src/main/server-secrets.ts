/**
 * The bundled API server's TOKEN_ENCRYPTION_KEY: the secret it encrypts stored
 * credentials with (tracker tokens, source browser sessions — see the server's
 * utils/tokenCrypto.ts). A self-hosted server is configured through its .env; the
 * installer's server has no .env, so the desktop app generates one key per installation
 * and keeps it beside the database, encrypted with safeStorage like the auth cache.
 *
 * Losing the key makes what it encrypted unreadable, so an existing file is never
 * replaced: if it cannot be decrypted (e.g. the OS keychain was reset), the server runs
 * without a key and the features that need one say so.
 */
import { app, safeStorage } from 'electron';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function keyFilePath(): string {
  return path.join(app.getPath('userData'), 'server-token-key.enc');
}

function isValidKey(value: string): boolean {
  return Buffer.from(value, 'base64').length === 32;
}

/** The key to hand the bundled server, or undefined to leave its environment alone (the
 * user set one themselves, or none can be stored safely). */
export function resolveServerTokenKey(): string | undefined {
  if (process.env.TOKEN_ENCRYPTION_KEY?.trim()) return undefined;
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn(
      '[main] OS credential encryption is unavailable; the bundled server runs without TOKEN_ENCRYPTION_KEY',
    );
    return undefined;
  }

  const filePath = keyFilePath();
  if (existsSync(filePath)) {
    try {
      const key = safeStorage.decryptString(readFileSync(filePath));
      if (isValidKey(key)) return key;
    } catch {
      // Falls through to the warning below.
    }
    console.warn(
      '[main] The stored server encryption key could not be read; the bundled server runs without TOKEN_ENCRYPTION_KEY',
    );
    return undefined;
  }

  const key = randomBytes(32).toString('base64');
  // 0600 as with the auth cache: already OS-encrypted, but no reason to leave it readable.
  writeFileSync(filePath, safeStorage.encryptString(key), { mode: 0o600, flag: 'wx' });
  return key;
}
