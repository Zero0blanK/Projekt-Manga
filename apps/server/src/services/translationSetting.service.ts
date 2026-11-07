/**
 * A reader's own machine-translation service (Reader › Page translation), used in place of
 * the host's TRANSLATE_* environment.
 *
 * The API key is write-only. It is encrypted at rest with the same key as tracker tokens
 * and alert destinations, and no response ever carries it, or any part of it: a client
 * learns only that a key is saved. Leaving the key out of a save keeps the saved one.
 */
import translationSettingRepository from '../repositories/translationSetting.repository.js';
import type { TranslateProvider, TranslateSettingsBody } from '@projekt-manga/schemas';
import { decryptToken, encryptToken } from '../utils/tokenCrypto.js';
import { ServiceUnavailableError, ValidationError } from '../utils/customErrors.js';

export interface TranslationSettingSummary {
  provider: TranslateProvider;
  url: string | null;
  /** A key is saved. The key itself is never returned. */
  has_key: boolean;
  /** False when a saved key can no longer be decrypted (TOKEN_ENCRYPTION_KEY changed). */
  key_readable: boolean;
  updated_at: Date;
}

/** A saved service, ready to call. */
export interface SavedTranslationService {
  provider: TranslateProvider;
  url: string | null;
  key?: string;
}

type Row = {
  provider: string;
  url: string | null;
  key_encrypted: string | null;
  updated_at: Date;
};

function readKey(row: Row): { key?: string; readable: boolean } {
  if (!row.key_encrypted) return { readable: true };
  try {
    return { key: decryptToken(row.key_encrypted), readable: true };
  } catch {
    return { readable: false };
  }
}

function summarize(row: Row): TranslationSettingSummary {
  return {
    provider: row.provider as TranslateProvider,
    url: row.url,
    has_key: row.key_encrypted !== null,
    key_readable: readKey(row).readable,
    updated_at: row.updated_at,
  };
}

/** Encrypts a key, or says plainly why it can't be saved. */
function encryptKey(key: string): string {
  try {
    return encryptToken(key);
  } catch (error) {
    if (error instanceof ServiceUnavailableError)
      throw new ServiceUnavailableError(
        'This server has no TOKEN_ENCRYPTION_KEY, so it cannot store an API key safely',
      );
    throw error;
  }
}

const get = async (user_id: string | null): Promise<TranslationSettingSummary | null> => {
  const row = await translationSettingRepository.find(user_id);
  return row ? summarize(row) : null;
};

const save = async (
  body: TranslateSettingsBody,
  user_id: string | null,
): Promise<TranslationSettingSummary> => {
  const existing = await translationSettingRepository.find(user_id);
  const keepKey = !body.api_key && !body.clear_api_key;
  const key_encrypted = body.api_key
    ? encryptKey(body.api_key)
    : keepKey
      ? (existing?.key_encrypted ?? null)
      : null;
  const url = body.url ?? null;

  if (body.provider === 'libretranslate' && !url)
    throw new ValidationError('LibreTranslate needs the address of the service');
  if (body.provider === 'deepl' && !key_encrypted)
    throw new ValidationError('DeepL needs an API key');

  return summarize(
    await translationSettingRepository.save(user_id, {
      provider: body.provider,
      url,
      key_encrypted,
    }),
  );
};

const remove = async (user_id: string | null) => {
  await translationSettingRepository.remove(user_id);
};

/**
 * The identity's saved service with its key decrypted, for the translate call only.
 * Null when nothing is saved, or when the saved key can no longer be read.
 */
const resolve = async (user_id: string | null): Promise<SavedTranslationService | null> => {
  const row = await translationSettingRepository.find(user_id);
  if (!row) return null;
  const { key, readable } = readKey(row);
  if (!readable) return null;
  return { provider: row.provider as TranslateProvider, url: row.url, ...(key ? { key } : {}) };
};

export default { get, save, remove, resolve };
