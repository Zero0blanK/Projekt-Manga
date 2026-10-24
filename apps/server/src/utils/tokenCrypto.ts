import crypto from 'crypto';
import { ServiceUnavailableError } from './customErrors.js';

/**
 * Encrypts tracker OAuth tokens at rest (`tracker_account.access_token`/
 * `refresh_token`) — the same class of secret as a password hash, never returned to
 * any client as plaintext and not something a database dump alone should hand over.
 * AES-256-GCM: a random 12-byte IV per call (stored alongside the ciphertext, not
 * secret) and the auth tag catches any tampering with the stored value, not just
 * accidental corruption.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

function getKey(): Buffer {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw) {
    // Fails closed rather than falling back to an ephemeral/derived key: a key that
    // isn't stable across restarts would make every previously-stored token
    // permanently undecryptable the moment the process restarts, silently breaking
    // every connected tracker account instead of failing loudly at the one place that
    // actually needs the key.
    throw new ServiceUnavailableError(
      'TOKEN_ENCRYPTION_KEY is not set — tracker sync cannot store credentials without it',
    );
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new ServiceUnavailableError(
      'TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes (base64-encoded)',
    );
  }
  return key;
}

/** Returns `iv:authTag:ciphertext`, each base64, colon-joined — plain enough to store
 * in a single TEXT column without a second column for the IV. */
export function encryptToken(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(
    ':',
  );
}

export function decryptToken(stored: string): string {
  const key = getKey();
  const [ivB64, authTagB64, ciphertextB64] = stored.split(':');
  if (!ivB64 || !authTagB64 || !ciphertextB64) {
    throw new ServiceUnavailableError(
      'Stored token value is not in the expected iv:authTag:ciphertext shape',
    );
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, 'base64')),
    decipher.final(),
  ]);
  return plaintext.toString('utf-8');
}

/** For generating a real TOKEN_ENCRYPTION_KEY value — not used at runtime, just a
 * documented way to produce one (see .env.example). */
export function generateEncryptionKey(): string {
  return crypto.randomBytes(32).toString('base64');
}
