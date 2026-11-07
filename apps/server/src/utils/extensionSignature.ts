import crypto, { type KeyObject } from 'node:crypto';
import { z } from 'zod';
import type { ExtensionListingEntry } from '@projekt-manga/schemas';
import { ValidationError } from './customErrors.js';

const trustedKeySchema = z.object({
  key_id: z.string().min(1).max(100),
  /** Base64-encoded DER SubjectPublicKeyInfo containing an Ed25519 public key. */
  public_key: z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
});
const trustedKeysConfigSchema = z.record(z.string().url(), z.array(trustedKeySchema).min(1));

export type TrustedExtensionSigningKeys = Map<string, Map<string, KeyObject>>;

/**
 * A repository URL in the form trust keys are looked up by.
 *
 * Matched on the exact string, a key configured for ".../index.json/" or "HTTPS://Host/..."
 * wouldn't find its repository, and that repository would then be treated as having no key
 * at all: signatures silently unenforced, on the one server that asked for them.
 */
export function canonicalRepositoryUrl(url: string): string {
  const parsed = new URL(url);
  parsed.hash = '';
  return parsed.href.replace(/\/+$/, '');
}

export const isTrustedRepository = (keys: TrustedExtensionSigningKeys, url: string) =>
  keys.has(canonicalRepositoryUrl(url));

/**
 * Reads public trust keys from an operator-managed JSON map. Private keys must stay with
 * repository maintainers and are never accepted by the server configuration.
 */
export function parseTrustedExtensionSigningKeys(raw: string): TrustedExtensionSigningKeys {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new Error('EXTENSION_REPOSITORY_TRUST_KEYS must be valid JSON');
  }
  const parsed = trustedKeysConfigSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new Error('EXTENSION_REPOSITORY_TRUST_KEYS must map repository URLs to public keys');
  }

  const result: TrustedExtensionSigningKeys = new Map();
  for (const [repositoryUrl, entries] of Object.entries(parsed.data)) {
    const keys = new Map<string, KeyObject>();
    for (const entry of entries) {
      if (keys.has(entry.key_id)) {
        throw new Error(`Duplicate extension signing key id configured for ${repositoryUrl}`);
      }
      let key: KeyObject;
      try {
        key = crypto.createPublicKey({
          key: Buffer.from(entry.public_key, 'base64'),
          format: 'der',
          type: 'spki',
        });
      } catch {
        throw new Error(`Invalid extension signing public key configured for ${repositoryUrl}`);
      }
      if (key.asymmetricKeyType !== 'ed25519') {
        throw new Error(`Extension signing key ${entry.key_id} must use Ed25519`);
      }
      keys.set(entry.key_id, key);
    }
    result.set(canonicalRepositoryUrl(repositoryUrl), keys);
  }
  return result;
}

/** Stable v1 envelope: fixed property order is part of the repository signing contract. */
export function extensionListingSigningPayload(
  repositoryUrl: string,
  entry: ExtensionListingEntry,
): Buffer {
  const source = {
    source_key: entry.source_key,
    ...(entry.family_key ? { family_key: entry.family_key } : {}),
    name: entry.name,
    lang: entry.lang,
    version: entry.version,
    entry_url: entry.entry_url,
    base_url: entry.base_url,
    allowed_hosts: entry.allowed_hosts,
    isNSFW: entry.isNSFW,
    content_rating: entry.content_rating,
    description: entry.description,
    homepage: entry.homepage,
    icon_url: entry.icon_url,
    api_version: entry.api_version,
    version_code: entry.version_code,
    bundle: entry.bundle,
    // Only when set, so listings signed before the field existed still verify.
    ...(entry.expires_at ? { expires_at: entry.expires_at } : {}),
  };
  return Buffer.from(
    JSON.stringify({
      format: 'projekt-manga-extension-signature-v1',
      repository_url: repositoryUrl,
      source,
    }),
    'utf8',
  );
}

/** Enforces signatures only for repositories the operator has explicitly trusted. */
export function verifyTrustedExtensionListing(
  repositoryUrl: string,
  entry: ExtensionListingEntry,
  bundleHash: string,
  bundleSize: number,
  trustedKeys: TrustedExtensionSigningKeys,
): void {
  const keys = trustedKeys.get(canonicalRepositoryUrl(repositoryUrl));
  if (!keys) return;

  if (!entry.bundle || entry.bundle.sha256 !== bundleHash || entry.bundle.size !== bundleSize) {
    throw new ValidationError(
      `The trusted repository must declare the exact bundle checksum and size for "${entry.source_key}".`,
    );
  }
  if (!entry.signature || entry.signature.algorithm !== 'ed25519') {
    throw new ValidationError(`The trusted repository did not sign "${entry.source_key}".`);
  }
  const publicKey = keys.get(entry.signature.key_id);
  if (!publicKey) {
    throw new ValidationError(
      `The signing key for "${entry.source_key}" is not trusted or has been revoked.`,
    );
  }

  let signature: Buffer;
  try {
    signature = Buffer.from(entry.signature.value, 'base64url');
  } catch {
    throw new ValidationError(`The signature for "${entry.source_key}" is invalid.`);
  }
  const valid =
    signature.byteLength === 64 &&
    crypto.verify(null, extensionListingSigningPayload(repositoryUrl, entry), publicKey, signature);
  if (!valid) {
    throw new ValidationError(`The signature for "${entry.source_key}" is invalid.`);
  }
  // Checked after the signature, so the date can be relied on. A listing that expires can't
  // be replayed later to hold an installation on an old, vulnerable version.
  if (entry.expires_at && Date.parse(entry.expires_at) <= Date.now()) {
    throw new ValidationError(`The signed listing for "${entry.source_key}" has expired.`);
  }
}
