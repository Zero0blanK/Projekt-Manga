import { z } from 'zod';

export const addExtensionRepositoryBodySchema = z.object({
  url: z.string().trim().url(),
});
export type AddExtensionRepositoryBody = z.infer<typeof addExtensionRepositoryBodySchema>;

export const installExtensionBodySchema = z.object({
  repository_id: z.string().min(1),
  source_key: z.string().min(1),
  /** Confirms the caller knows this repository is not signed by a key the operator trusts. */
  acknowledge_unsigned: z.boolean().optional(),
});
/** Prefix of the 409 message returned when an install needs `acknowledge_unsigned`. */
export const UNSIGNED_REPOSITORY_ERROR = 'Unsigned repository';
export type InstallExtensionBody = z.infer<typeof installExtensionBodySchema>;

/**
 * The highest `format_version` this app knows how to read.
 *
 * A repository bumps its index's `format_version` only when a change would make an older
 * reader *misread* the file — a renamed field, a removed one, or one whose meaning changed.
 * So a higher number is the one case where guessing is worse than refusing: the fields we
 * recognise may no longer mean what we think.
 */
export const SUPPORTED_INDEX_FORMAT_VERSION = 1;

/**
 * The highest extension contract (`Source` in `@projekt-manga/types`) this app can drive.
 *
 * A source built against a newer contract may expect methods or argument shapes the sandbox
 * runner does not implement, so installing it would produce a source that loads and then
 * fails in ways the user cannot act on. Refusing at install time is the honest answer.
 */
export const SUPPORTED_EXTENSION_API_VERSION = 1;

/**
 * Shape of the JSON index a repository URL is expected to serve — one entry per
 * installable source. `allowed_hosts` is the sandboxed source's network allowlist: every
 * hostname the source's code is permitted to reach, checked by the parent process
 * before any outbound request the sandboxed code makes is actually performed.
 */
export const extensionListingEntrySchema = z.object({
  source_key: z.string().trim().min(1).max(100),
  /** Language editions belonging to the same source, scoped to their repository. */
  family_key: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,99}$/)
    .optional(),
  name: z.string().trim().min(1).max(255),
  lang: z.string().trim().min(1).max(20),
  version: z.string().trim().min(1).max(50),
  entry_url: z.string().trim().url(),
  base_url: z.string().trim().url(),
  allowed_hosts: z.array(z.string().trim().min(1)).min(1).max(20),
  isNSFW: z.boolean(),

  /**
   * How much adult content the source carries.
   *
   * `isNSFW` above is derived from this and is true only for `nsfw`, so it cannot express
   * `mixed` — a general catalogue that also carries adult titles, which is meant to be
   * badged rather than hidden. Optional: a repository that predates the field leaves the
   * app with only the boolean, which is why `isNSFW` stays required rather than derived.
   */
  content_rating: z.enum(['safe', 'mixed', 'nsfw']).optional(),

  /** One line for the install listing. */
  description: z.string().trim().max(200).optional(),
  /** Where to send a human, when that differs from `base_url` (an API-backed source points
   * `base_url` at its API). */
  homepage: z.string().trim().url().optional(),
  /** Absent when the source ships no icon — render a fallback, not a broken image. */
  icon_url: z.string().trim().url().optional(),

  /** Which extension contract the bundle implements. Optional because a repository built
   * before this field existed omits it; absent is read as 1, the contract that predates it. */
  api_version: z.number().int().positive().optional(),

  /** `major*1e6 + minor*1e3 + patch`, for ordering two versions without parsing strings.
   * Optional for the same reason; `version` is parsed as a fallback. */
  version_code: z.number().int().nonnegative().optional(),

  /**
   * Integrity for the bytes at `entry_url`.
   *
   * `entry_url` typically points at a mutable branch URL, so the file that arrives is not
   * necessarily the file the listing describes — a stale CDN copy and a truncated download
   * both look like a successful fetch. This is what ties the two together.
   *
   * Optional, so a repository that doesn't publish it still works; when present it is
   * enforced. Note what that does and does not buy: it protects against the bytes changing
   * between publish and download, not against a repository that is itself hostile — such a
   * repository controls both the listing and the bundle, and could simply omit this. Guarding
   * against *that* needs signing, which the format does not have yet.
   */
  bundle: z
    .object({
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      size: z.number().int().positive(),
    })
    .optional(),

  /** Ed25519 signature over the canonical listing envelope documented in
   * docs/extension-repository.md. It is authenticated only when the server operator has
   * configured a matching out-of-band public key for this repository URL. */
  signature: z
    .object({
      algorithm: z.literal('ed25519'),
      key_id: z.string().trim().min(1).max(100),
      value: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
    })
    .optional(),
});
export type ExtensionListingEntry = z.infer<typeof extensionListingEntrySchema>;

export const extensionRepositoryIndexSchema = z.object({
  /** Absent means a repository published before the field existed, which by definition
   * predates any breaking change — read as 1. */
  format_version: z.number().int().positive().optional(),

  /** How the repository names and describes itself, so the UI can attribute an installed
   * source to somewhere recognisable rather than to a raw URL. All optional — a repository
   * need not publish any of it. `contact` is not parsed: nothing renders it yet. */
  repository: z
    .object({
      name: z.string().trim().min(1).max(255),
      /** A chip, not a sentence — the format caps this at six characters. */
      badge_label: z.string().trim().max(6).optional(),
      description: z.string().trim().max(500).optional(),
      website: z.string().trim().url().optional(),
    })
    .optional(),

  sources: z.array(extensionListingEntrySchema).max(200),
});
export type ExtensionRepositoryIndex = z.infer<typeof extensionRepositoryIndexSchema>;
