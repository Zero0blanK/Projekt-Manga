import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { extensionListingEntrySchema } from '@projekt-manga/schemas';
import {
  extensionListingSigningPayload,
  parseTrustedExtensionSigningKeys,
  verifyTrustedExtensionListing,
} from '../src/utils/extensionSignature.js';

const repositoryUrl = 'https://example.test/index.json';

function signedEntry() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const bundle = Buffer.from('export default { fetchManga: async () => [] };');
  const entry = extensionListingEntrySchema.parse({
    source_key: 'fixture-source',
    name: 'Fixture Source',
    lang: 'en',
    version: '1.0.0',
    entry_url: 'https://example.test/source.js',
    base_url: 'https://example.test',
    allowed_hosts: ['example.test'],
    isNSFW: false,
    bundle: {
      sha256: crypto.createHash('sha256').update(bundle).digest('hex'),
      size: bundle.byteLength,
    },
  });
  const signature = crypto
    .sign(null, extensionListingSigningPayload(repositoryUrl, entry), privateKey)
    .toString('base64url');
  return {
    bundle,
    entry: {
      ...entry,
      signature: { algorithm: 'ed25519' as const, key_id: 'fixture-2026', value: signature },
    },
    publicKey,
  };
}

function trustConfig(publicKey: crypto.KeyObject) {
  return parseTrustedExtensionSigningKeys(
    JSON.stringify({
      [repositoryUrl]: [
        {
          key_id: 'fixture-2026',
          public_key: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
        },
      ],
    }),
  );
}

describe('trusted extension signatures', () => {
  it('rejects adding language family metadata after signing', () => {
    const { bundle, entry, publicKey } = signedEntry();
    expect(() =>
      verifyTrustedExtensionListing(
        repositoryUrl,
        { ...entry, family_key: 'different-family' },
        entry.bundle!.sha256,
        bundle.byteLength,
        trustConfig(publicKey),
      ),
    ).toThrow('signature');
  });

  it('accepts a valid signature over the repository and security metadata', () => {
    const { bundle, entry, publicKey } = signedEntry();
    expect(() =>
      verifyTrustedExtensionListing(
        repositoryUrl,
        entry,
        entry.bundle!.sha256,
        bundle.byteLength,
        trustConfig(publicKey),
      ),
    ).not.toThrow();
  });

  it('rejects changes to allowed hosts after signing', () => {
    const { bundle, entry, publicKey } = signedEntry();
    expect(() =>
      verifyTrustedExtensionListing(
        repositoryUrl,
        { ...entry, allowed_hosts: ['example.test', 'attacker.test'] },
        entry.bundle!.sha256,
        bundle.byteLength,
        trustConfig(publicKey),
      ),
    ).toThrow('signature');
  });

  it('rejects a missing or revoked key for a trusted repository', () => {
    const { bundle, entry, publicKey } = signedEntry();
    const noKeys = parseTrustedExtensionSigningKeys(
      JSON.stringify({
        [repositoryUrl]: [
          {
            key_id: 'rotated-away',
            public_key: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
          },
        ],
      }),
    );
    expect(() =>
      verifyTrustedExtensionListing(
        repositoryUrl,
        entry,
        entry.bundle!.sha256,
        bundle.byteLength,
        noKeys,
      ),
    ).toThrow('not trusted or has been revoked');
  });

  it('requires exact checksum metadata and refuses an unsigned entry for a trusted repository', () => {
    const { bundle, entry, publicKey } = signedEntry();
    const trusted = trustConfig(publicKey);
    expect(() =>
      verifyTrustedExtensionListing(
        repositoryUrl,
        { ...entry, signature: undefined },
        entry.bundle!.sha256,
        bundle.byteLength,
        trusted,
      ),
    ).toThrow('did not sign');
    expect(() =>
      verifyTrustedExtensionListing(
        repositoryUrl,
        { ...entry, bundle: undefined },
        entry.bundle!.sha256,
        bundle.byteLength,
        trusted,
      ),
    ).toThrow('exact bundle checksum and size');
  });

  it('leaves repositories outside the operator trust map unsigned and untrusted', () => {
    const { bundle, entry } = signedEntry();
    expect(() =>
      verifyTrustedExtensionListing(
        'https://other.test/index.json',
        { ...entry, signature: undefined },
        entry.bundle!.sha256,
        bundle.byteLength,
        parseTrustedExtensionSigningKeys('{}'),
      ),
    ).not.toThrow();
  });

  it('rejects non-Ed25519 keys and duplicate key ids', () => {
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey;
    const rsaConfig = JSON.stringify({
      [repositoryUrl]: [
        {
          key_id: 'bad',
          public_key: rsa.export({ format: 'der', type: 'spki' }).toString('base64'),
        },
      ],
    });
    expect(() => parseTrustedExtensionSigningKeys(rsaConfig)).toThrow('must use Ed25519');

    const { publicKey } = signedEntry();
    const key = {
      key_id: 'duplicate',
      public_key: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    };
    expect(() =>
      parseTrustedExtensionSigningKeys(JSON.stringify({ [repositoryUrl]: [key, key] })),
    ).toThrow('Duplicate extension signing key id');
  });
});
