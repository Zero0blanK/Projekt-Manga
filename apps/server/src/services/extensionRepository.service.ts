import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import axios from 'axios';
// The `/sandbox` subpath — see the note in sandboxedSourceRegistry.service.ts.
import { spawnSandboxedSource } from '@projekt-manga/extensions/sandbox';
import type { Source } from '@projekt-manga/types';
import extensionRepositoryRepository, {
  type RepositoryMetadataInput,
} from '../repositories/extensionRepository.repository.js';
import {
  assertPublicHttpUrl,
  isDisallowedRedirectHost,
  guardedHttpAgent,
  guardedHttpsAgent,
} from '../utils/ssrfGuard.js';
import {
  extensionRepositoryIndexSchema,
  SUPPORTED_EXTENSION_API_VERSION,
  SUPPORTED_INDEX_FORMAT_VERSION,
  UNSIGNED_REPOSITORY_ERROR,
  type ExtensionListingEntry,
} from '@projekt-manga/schemas';
import {
  AppError,
  DuplicateResourceError,
  NotFoundError,
  ValidationError,
  UpstreamError,
} from '../utils/customErrors.js';
import {
  parseTrustedExtensionSigningKeys,
  verifyTrustedExtensionListing,
} from '../utils/extensionSignature.js';

/** Repo indexes and source bundles are both fetched from a URL the user typed in — same
 * SSRF exposure as the existing image-proxy/thumbnail-sync code, guarded the same way. */
const MAX_INDEX_BYTES = 1024 * 1024; // 1MB — a listing of installable sources is metadata, not a payload
const MAX_BUNDLE_BYTES = 10 * 1024 * 1024; // 10MB — generous for a bundled scraper, not for a full app

function resolveBundlesDir(): string {
  return (
    process.env.EXTENSION_BUNDLES_DIR || path.join(process.cwd(), 'data', 'installed-extensions')
  );
}

async function fetchWithSizeCap(url: string, maxBytes: number): Promise<Buffer> {
  await assertPublicHttpUrl(url);
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 20000,
    maxContentLength: maxBytes,
    maxBodyLength: maxBytes,
    // Validates the address every hop actually connects to, which beforeRedirect
    // (hostname only) and a pre-flight DNS check (TOCTOU) both miss.
    httpAgent: guardedHttpAgent,
    httpsAgent: guardedHttpsAgent,
    beforeRedirect: (options) => {
      if (isDisallowedRedirectHost(String(options.hostname))) {
        throw new Error('Redirect target is disallowed');
      }
    },
  });
  const buffer = Buffer.from(response.data as ArrayBuffer);
  if (buffer.byteLength > maxBytes) {
    throw new ValidationError(`Response exceeded the ${maxBytes}-byte limit`);
  }
  return buffer;
}

interface FetchedIndex {
  /** How the repository describes itself, flattened to what the columns hold. Every field
   * is null when it publishes no `repository` block, or omits that field. */
  repository: RepositoryMetadataInput;
  sources: ExtensionListingEntry[];
}

/**
 * Makes a URL the CDN in front of it has to treat as new.
 *
 * Repository indexes are static files behind a cache (GitHub's raw host uses
 * `max-age=300`), so a plain re-request can return a stale index. Passive listing tolerates
 * that; an explicit "Refresh" must not. A unique query string reliably reaches the origin,
 * whereas a client `Cache-Control: no-cache` is advisory and CDNs may ignore it.
 */
function withCacheBuster(url: string): string {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}_=${Date.now()}`;
}

/** Fetches and validates a repository's index — never trusted as-is, always re-parsed
 * against the schema regardless of what a previous fetch returned. */
const fetchRepositoryIndex = async (
  url: string,
  options: { bustCache?: boolean } = {},
): Promise<FetchedIndex> => {
  let raw: Buffer;
  try {
    raw = await fetchWithSizeCap(options.bustCache ? withCacheBuster(url) : url, MAX_INDEX_BYTES);
  } catch (error) {
    throw new UpstreamError(
      `Could not fetch the repository index: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw.toString('utf-8'));
  } catch {
    throw new ValidationError('Repository index is not valid JSON');
  }

  const result = extensionRepositoryIndexSchema.safeParse(parsedJson);
  if (!result.success) {
    throw new ValidationError(
      `Repository index does not match the expected shape: ${result.error.message}`,
    );
  }

  // Checked before anything reads a single entry: a newer format may have redefined the
  // fields below, so parsing them as though nothing changed is the one outcome the version
  // exists to prevent.
  const formatVersion = result.data.format_version ?? 1;
  if (formatVersion > SUPPORTED_INDEX_FORMAT_VERSION) {
    throw new ValidationError(
      `This repository uses index format ${formatVersion}, but this version of the app only understands up to ${SUPPORTED_INDEX_FORMAT_VERSION}. Update the app to add it.`,
    );
  }

  const published = result.data.repository;
  return {
    repository: {
      name: published?.name ?? null,
      badge_label: published?.badge_label ?? null,
      description: published?.description ?? null,
      website: published?.website ?? null,
    },
    sources: result.data.sources,
  };
};

const addRepository = async (url: string) => {
  const existing = await extensionRepositoryRepository.getRepositoryByUrl(url);
  if (existing) {
    throw new DuplicateResourceError('This repository has already been added');
  }

  // Fetching now (rather than only when first listed) fails loudly at add-time if the
  // URL doesn't actually serve a valid index, instead of silently storing a dead repo.
  const { repository } = await fetchRepositoryIndex(url);

  // Stored so the UI can show "ProjektManga sources" rather than a raw githubusercontent
  // URL. Null when the repository publishes none; the panel already falls back to the URL.
  return await extensionRepositoryRepository.createRepository(url, repository);
};

const listRepositoriesWithListings = async () => {
  const repositories = await extensionRepositoryRepository.getAllRepositories();
  return await Promise.all(
    repositories.map(async (repository) => {
      try {
        const { sources } = await fetchRepositoryIndex(repository.url);
        return { ...repository, sources, fetchError: null as string | null };
      } catch (error) {
        return {
          ...repository,
          sources: [] as ExtensionListingEntry[],
          fetchError: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
};

const refreshRepository = async (id: string) => {
  const repository = await extensionRepositoryRepository.getRepositoryById(id);
  if (!repository) {
    throw new NotFoundError('Repository not found');
  }
  // A refresh is also when a repository that has been renamed — or that only started
  // publishing a name — gets picked up, so the stored metadata follows the listing.
  //
  // Cache-busted, unlike the passive listing: this is the explicit "check now" path, and
  // without it a publisher who just pushed keeps being shown the pre-push index for the
  // life of the CDN's cache no matter how many times they press it.
  const { repository: metadata, sources } = await fetchRepositoryIndex(repository.url, {
    bustCache: true,
  });
  const updated = await extensionRepositoryRepository.touchRepositoryFetchedAt(id, metadata);
  return { ...updated, sources };
};

const deleteRepository = async (id: string) => {
  const repository = await extensionRepositoryRepository.getRepositoryById(id);
  if (!repository) {
    throw new NotFoundError('Repository not found');
  }
  const installed = await extensionRepositoryRepository.getInstalledExtensionsForRepository(id);
  // Cascades installed_extensions via the FK. Done before the bundles are removed for the
  // same reason as deleteInstalledExtension: a failure here would otherwise leave rows
  // whose bundles no longer exist, and a stranded directory is the cheaper of the two.
  await extensionRepositoryRepository.deleteRepository(id);
  for (const extension of installed) {
    await removeBundleFile(extension.id);
    failedUpdateVersions.delete(extension.id);
  }
};

async function bundleDirFor(installedExtensionId: string): Promise<string> {
  const dir = path.join(resolveBundlesDir(), installedExtensionId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function removeBundleFile(installedExtensionId: string): Promise<void> {
  const dir = path.join(resolveBundlesDir(), installedExtensionId);
  await fs.rm(dir, { recursive: true, force: true });
}

function findListingEntry(
  sources: ExtensionListingEntry[],
  source_key: string,
): ExtensionListingEntry {
  const entry = sources.find((s) => s.source_key === source_key);
  if (!entry) {
    throw new NotFoundError(`Repository listing has no source with key "${source_key}"`);
  }
  return entry;
}

/**
 * The listing fields a repository may or may not publish, flattened to what the columns
 * hold. Shared by install and update so the two can't capture different subsets — a source
 * that gained an icon on update should show one, not keep the null it installed with.
 */
function listingMetadata(entry: ExtensionListingEntry) {
  return {
    api_version: entry.api_version ?? 1,
    content_rating: entry.content_rating ?? null,
    version_code: entry.version_code ?? null,
    description: entry.description ?? null,
    homepage: entry.homepage ?? null,
    icon_url: entry.icon_url ?? null,
  };
}

/**
 * Refuses a source built against a contract this app cannot drive.
 *
 * Checked at install and update rather than filtered out of the listing, so the user gets
 * "this needs a newer app" instead of a source that silently isn't there.
 */
function assertSupportedApiVersion(entry: ExtensionListingEntry): void {
  const apiVersion = entry.api_version ?? 1;
  if (apiVersion > SUPPORTED_EXTENSION_API_VERSION) {
    throw new ValidationError(
      `"${entry.source_key}" needs extension API version ${apiVersion}, but this version of the app supports up to ${SUPPORTED_EXTENSION_API_VERSION}. Update the app to install it.`,
    );
  }
}

/**
 * Checks downloaded bytes against the hash and size the listing declared, and returns the
 * hash so the caller can store it without paying for a second pass over the same buffer.
 *
 * Without the check the app hashes whatever arrived and stores *that* as the source of
 * truth, so a stale CDN copy or a truncated download installs cleanly and its wrong hash
 * silently becomes the baseline every future update is compared against.
 *
 * The hash is computed even when the listing declares none, because it is stored either
 * way — there is nothing to save by skipping it.
 *
 * Size is checked first only because it gives the clearer message of the two; a mismatch in
 * either is refused the same way.
 */
function verifyBundleAgainstListing(entry: ExtensionListingEntry, bundle: Buffer): string {
  const actual = crypto.createHash('sha256').update(bundle).digest('hex');
  if (!entry.bundle) return actual;

  if (bundle.byteLength !== entry.bundle.size) {
    throw new ValidationError(
      `The bundle for "${entry.source_key}" is ${bundle.byteLength} bytes but its listing declares ${entry.bundle.size}. The repository may have been rebuilt without updating its index, or a cache is serving an older copy.`,
    );
  }

  if (actual !== entry.bundle.sha256) {
    throw new ValidationError(
      `The bundle for "${entry.source_key}" does not match the checksum in its listing. Refusing to install it.`,
    );
  }

  return actual;
}

/**
 * Orders two versions of the same source.
 *
 * Prefers `version_code` when *both* sides have one (the publisher's own ordering).
 * Otherwise compares `major.minor.patch` numerically; string inequality has no ordering and
 * would let an older listing read as an update.
 *
 * The two scales are never mixed, hence taking the installed row rather than its version
 * string: `version_code` is a publisher-chosen counter (any non-negative int), while a
 * parsed version sits on a major*1e6 + minor*1e3 + patch scale, so comparing across them
 * would misreport upgrades as downgrades.
 *
 * Returns a positive number when `entry` is newer than the installed row, 0 when they are the
 * same, negative when it is older, and 0 for anything unparseable so that an odd version
 * string falls through to the hash comparison rather than being treated as a downgrade.
 */
function compareToInstalledVersion(
  entry: ExtensionListingEntry,
  installed: { version: string; version_code: number | null },
): number {
  const parse = (value: string): number | null => {
    const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value.trim());
    if (!match) return null;
    return Number(match[1]) * 1_000_000 + Number(match[2]) * 1_000 + Number(match[3]);
  };

  // Both sides, or neither — a code on only one side says nothing about ordering.
  if (entry.version_code != null && installed.version_code != null) {
    return entry.version_code - installed.version_code;
  }

  const installedParsed = parse(installed.version);
  if (installedParsed === null) return 0;

  const candidate = parse(entry.version);
  if (candidate === null) return 0;

  return candidate - installedParsed;
}

/**
 * Versions that failed their smoke test, per installed extension.
 *
 * Kept in memory, not in a column: the periodic update check that would otherwise loop
 * runs in this same process. A restart retries a known-bad version once more.
 */
const failedUpdateVersions = new Map<string, string>();

/**
 * Loads a staged bundle in a real sandbox and calls one cheap method.
 *
 * Returns null when it works, or a short reason when it doesn't. `getFilters` is the probe
 * because it is in the runner's allowlist and is the one method sources answer from static
 * data — `fetchManga` would put an upstream site's availability in the path of our own
 * update check, so a site being down would look like a bad bundle.
 *
 * Merely loading is most of the value: the runner rejects a bundle that isn't an ES module
 * or doesn't default-export something with a `fetchManga` function.
 */
async function smokeTestBundle(
  bundlePath: string,
  entry: ExtensionListingEntry,
): Promise<string | null> {
  let candidate: (Source & { dispose(): void }) | null = null;
  try {
    candidate = spawnSandboxedSource(
      {
        id: entry.source_key,
        name: entry.name,
        lang: entry.lang,
        base_url: entry.base_url,
        isNSFW: entry.isNSFW,
      },
      {
        bundlePath,
        allowedNetHosts: entry.allowed_hosts,
        validateOutboundUrl: async (url: URL) => {
          try {
            await assertPublicHttpUrl(url.href);
            return true;
          } catch {
            return false;
          }
        },
      },
    );

    await candidate.getFilters();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    // Always disposed: a probe process left running would leak one child per update check.
    candidate?.dispose();
  }
}

const installExtension = async (
  repository_id: string,
  source_key: string,
  acknowledgeUnsigned = false,
) => {
  const repository = await extensionRepositoryRepository.getRepositoryById(repository_id);
  if (!repository) {
    throw new NotFoundError('Repository not found');
  }

  // Without an operator-trusted key the bundle checksum comes from the same index that lists
  // the bundle, so it proves nothing about who wrote the code. Installing is still allowed,
  // but only on the caller's explicit say-so.
  const trustedKeys = parseTrustedExtensionSigningKeys(
    process.env.EXTENSION_REPOSITORY_TRUST_KEYS ?? '{}',
  );
  if (!trustedKeys.has(repository.url) && !acknowledgeUnsigned) {
    throw new AppError(
      `${UNSIGNED_REPOSITORY_ERROR}: this repository does not sign its sources, so nothing verifies who wrote "${source_key}". Confirm to install it anyway.`,
      409,
      'UnsignedRepositoryError',
    );
  }

  const existing = await extensionRepositoryRepository.getInstalledExtensionByKey(
    repository_id,
    source_key,
  );
  if (existing) {
    throw new DuplicateResourceError('This source is already installed from this repository');
  }

  // The unique constraint is on (repository_id, source_key), so the database is perfectly
  // happy to store the same key twice from two different repositories — and then
  // getInstalledSandboxedSources() has to drop one of them, leaving a source the user
  // installed, sees listed as installed, and that silently never loads. Discover disables
  // the button for this case (CatalogEntry.conflictsWithInstalled), but the two entries sit
  // under different per-repository busy keys, so a quick pair of clicks still gets here —
  // and a direct API call always could. Refusing with a reason beats installing something
  // inert.
  const allInstalled = await extensionRepositoryRepository.getInstalledExtensions();
  const conflicting = allInstalled.find(
    (row) => row.source_key === source_key && row.repository_id !== repository_id,
  );
  if (conflicting) {
    throw new DuplicateResourceError(
      `Another installed source already provides "${source_key}". Uninstall that one first.`,
    );
  }

  const { sources } = await fetchRepositoryIndex(repository.url);
  const entry = findListingEntry(sources, source_key);
  assertSupportedApiVersion(entry);

  const bundleBuffer = await fetchWithSizeCap(entry.entry_url, MAX_BUNDLE_BYTES);
  const hash = verifyBundleAgainstListing(entry, bundleBuffer);
  verifyTrustedExtensionListing(
    repository.url,
    entry,
    hash,
    bundleBuffer.byteLength,
    parseTrustedExtensionSigningKeys(process.env.EXTENSION_REPOSITORY_TRUST_KEYS ?? '{}'),
  );

  const created = await extensionRepositoryRepository.createInstalledExtension({
    repository_id,
    source_key: entry.source_key,
    name: entry.name,
    lang: entry.lang,
    base_url: entry.base_url,
    is_nsfw: entry.isNSFW,
    allowed_hosts: entry.allowed_hosts,
    version: entry.version,
    entry_url: entry.entry_url,
    source_code_hash: hash,
    ...listingMetadata(entry),
  });

  // The bundle directory is keyed by the row's id, so the row has to exist first. That
  // leaves a window where a failed write would strand a row pointing at a bundle that was
  // never written — an extension the app lists, spawns, and fails on every call. Undo the
  // row rather than leave it.
  try {
    const dir = await bundleDirFor(created.id);
    await fs.writeFile(path.join(dir, 'bundle.js'), bundleBuffer);
  } catch (error) {
    await extensionRepositoryRepository.deleteInstalledExtension(created.id).catch(() => {});
    await removeBundleFile(created.id);
    throw new UpstreamError(
      `Could not store the bundle for "${entry.source_key}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return created;
};

const updateExtension = async (id: string) => {
  const installed = await extensionRepositoryRepository.getInstalledExtensionById(id);
  if (!installed) {
    throw new NotFoundError('Installed extension not found');
  }
  const dir = await bundleDirFor(installed.id);
  const livePath = path.join(dir, 'bundle.js');
  const backupPath = path.join(dir, 'bundle.previous.js');
  const backup = await fs.readFile(backupPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (backup) {
    const live = await fs.readFile(livePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (
      live &&
      crypto.createHash('sha256').update(live).digest('hex') === installed.source_code_hash
    ) {
      await fs.rm(backupPath);
    } else if (
      crypto.createHash('sha256').update(backup).digest('hex') === installed.source_code_hash
    ) {
      await fs.copyFile(backupPath, livePath);
      await fs.rm(backupPath);
    } else {
      throw new UpstreamError('Installed extension has an unrecoverable bundle/hash mismatch');
    }
  }
  const repository = await extensionRepositoryRepository.getRepositoryById(installed.repository_id);
  if (!repository) {
    throw new NotFoundError('Repository not found');
  }

  const { sources } = await fetchRepositoryIndex(repository.url);
  const entry = findListingEntry(sources, installed.source_key);
  assertSupportedApiVersion(entry);

  // Checked before the bundle is fetched: a version that already failed its smoke test
  // this run is not retried at all. Without this the periodic check re-downloads (up to
  // 10MB) and re-spawns the same broken bundle every cycle.
  if (failedUpdateVersions.get(id) === entry.version) {
    return { installed, changed: false };
  }

  // An "update" that moves backwards is not one. The checks below treat any difference as a
  // change, so without this a repository that rolled its listing back — or briefly served an
  // older index from a cache — would quietly downgrade a working source, and the periodic
  // check would keep doing it. Staying put is always the safe read of a lower version.
  if (compareToInstalledVersion(entry, installed) < 0) {
    return { installed, changed: false };
  }

  const bundleBuffer = await fetchWithSizeCap(entry.entry_url, MAX_BUNDLE_BYTES);
  let hash: string;
  try {
    hash = verifyBundleAgainstListing(entry, bundleBuffer);
    verifyTrustedExtensionListing(
      repository.url,
      entry,
      hash,
      bundleBuffer.byteLength,
      parseTrustedExtensionSigningKeys(process.env.EXTENSION_REPOSITORY_TRUST_KEYS ?? '{}'),
    );
  } catch (error) {
    // Remembered for the same reason a failed smoke test is: a repository whose listing
    // disagrees with its own bundle stays that way until someone republishes it, so
    // without this the periodic check re-downloads up to 10MB of it on every cycle.
    failedUpdateVersions.set(id, entry.version);
    throw error;
  }

  // A repo widening this source's network allowlist without touching the bundle code at
  // all is exactly as worth surfacing as a code change — arguably more so, since it's
  // invisible in a hash diff. Any declared-metadata drift counts as "changed" here, not
  // just the bundle itself.
  const installedAllowedHosts = installed.allowed_hosts as string[];
  const metadataChanged =
    entry.lang !== installed.lang ||
    entry.base_url !== installed.base_url ||
    entry.isNSFW !== installed.is_nsfw ||
    JSON.stringify(entry.allowed_hosts) !== JSON.stringify(installedAllowedHosts) ||
    // A source moving between safe/mixed/nsfw changes how it is presented to the user, so
    // it belongs in the same "declared metadata drifted" bucket as the allowlist widening
    // above rather than waiting for a code change to carry it across.
    // Both sides normalised: the column is nullable, and a row written before it existed
    // reads back as null, so comparing an absent listing field against it directly would
    // report drift on every check forever.
    (entry.content_rating ?? null) !== (installed.content_rating ?? null);
  const changed =
    hash !== installed.source_code_hash || entry.version !== installed.version || metadataChanged;
  if (!changed) {
    return { installed, changed: false };
  }

  const stagedPath = path.join(dir, 'bundle.next.js');

  /**
   * Staged promotion rather than an in-place overwrite: the new bundle is written beside
   * the live one, loaded in a real sandbox, and only promoted once it answers, so a bad
   * upstream publish cannot break a working source.
   */
  await fs.writeFile(stagedPath, bundleBuffer);

  const smokeTestError = await smokeTestBundle(stagedPath, entry);
  if (smokeTestError) {
    // The live bundle was never touched, so the previously-working version keeps serving.
    await fs.rm(stagedPath, { force: true });
    failedUpdateVersions.set(id, entry.version);
    throw new UpstreamError(
      `Update for "${installed.source_key}" v${entry.version} failed its load check and was discarded; the installed version is still active. (${smokeTestError})`,
    );
  }

  // Keep the previous verified bundle until the metadata commit succeeds. Otherwise a
  // database failure leaves the new bytes paired with the old hash and disables a source.
  let promoted = false;
  let keepBackup = false;
  let updated;
  try {
    await fs.copyFile(livePath, backupPath);
    await fs.rename(stagedPath, livePath);
    promoted = true;
    updated = await extensionRepositoryRepository.updateInstalledExtension(id, {
      lang: entry.lang,
      base_url: entry.base_url,
      is_nsfw: entry.isNSFW,
      allowed_hosts: entry.allowed_hosts,
      version: entry.version,
      entry_url: entry.entry_url,
      source_code_hash: hash,
      ...listingMetadata(entry),
    });
  } catch (error) {
    if (promoted) {
      try {
        await fs.copyFile(backupPath, livePath);
      } catch (rollbackError) {
        keepBackup = true;
        throw new Error(
          'Extension metadata update failed and the previous bundle could not be restored',
          { cause: rollbackError },
        );
      }
    }
    throw error;
  } finally {
    await fs.rm(stagedPath, { force: true });
    if (!keepBackup) await fs.rm(backupPath, { force: true });
  }
  failedUpdateVersions.delete(id);

  return { installed: updated, changed: true };
};

export interface UpdateCheckResult {
  checked: number;
  updated: string[];
  failed: { source_key: string; reason: string }[];
}

/**
 * Checks every installed extension for a new version and applies what passes its smoke
 * test.
 *
 * Sequential, not parallel: each update may spawn a sandbox child for its smoke test, so
 * many sources must not mean many concurrent Node processes. Failures are collected rather
 * than thrown so one unreachable repository does not stop the others being checked.
 */
const checkForUpdates = async (): Promise<UpdateCheckResult> => {
  const installed = await extensionRepositoryRepository.getInstalledExtensions();
  const result: UpdateCheckResult = { checked: 0, updated: [], failed: [] };

  for (const extension of installed) {
    if (!extension.enabled) continue;
    result.checked += 1;

    try {
      const { changed } = await updateExtension(extension.id);
      if (changed) result.updated.push(extension.source_key);
    } catch (error) {
      result.failed.push({
        source_key: extension.source_key,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
};

const deleteInstalledExtension = async (id: string) => {
  const installed = await extensionRepositoryRepository.getInstalledExtensionById(id);
  if (!installed) {
    throw new NotFoundError('Installed extension not found');
  }
  // Row first, then the bytes. The other order leaves a row pointing at a bundle that is
  // already gone if the delete fails — an extension the app lists, spawns and fails on
  // every call, which is the same broken state install() goes out of its way to avoid. A
  // failure after this point only leaks a directory, which nothing reads.
  await extensionRepositoryRepository.deleteInstalledExtension(id);
  await removeBundleFile(id);
  // Otherwise this grows for the life of the process, and a reinstall that happened to be
  // handed the same row id would inherit a "this version is broken" verdict about a
  // bundle that is no longer installed.
  failedUpdateVersions.delete(id);
};

const getBundlePath = (installedExtensionId: string): string => {
  return path.join(resolveBundlesDir(), installedExtensionId, 'bundle.js');
};

const extensionRepositoryService = {
  fetchRepositoryIndex,
  addRepository,
  listRepositoriesWithListings,
  refreshRepository,
  deleteRepository,
  installExtension,
  updateExtension,
  checkForUpdates,
  deleteInstalledExtension,
  getBundlePath,
  getAllInstalledExtensions: extensionRepositoryRepository.getInstalledExtensions,
};

export default extensionRepositoryService;
