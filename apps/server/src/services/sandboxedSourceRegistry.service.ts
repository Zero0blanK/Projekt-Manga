import crypto from 'crypto';
import fs from 'fs/promises';
// The `/sandbox` subpath, not the package root: the root re-exports the anti-detection
// stack, which loads puppeteer and playwright. Nothing here needs them — a sandboxed source
// has no child-process permission and no network of its own, so it could not drive a browser
// even if one were present — and importing the root would make the desktop installer carry
// a browser stack it can never use.
import { spawnSandboxedSource } from '@projekt-manga/extensions/sandbox';
import type { Source } from '@projekt-manga/types';
import extensionRepositoryRepository from '../repositories/extensionRepository.repository.js';
import extensionRepositoryService from './extensionRepository.service.js';
import { assertPublicHttpUrl } from '../utils/ssrfGuard.js';
import { guardedFetch } from '../utils/guardedFetch.js';

/**
 * Keeps one live sandboxed child process per enabled installed_extension row, reused
 * across calls (see spawnSandboxedSource.ts). Re-checks the database on every call so
 * install/update/remove/disable takes effect on the next request without a restart.
 */
interface RegistryEntry {
  source: Source & { dispose(): void };
  sourceCodeHash: string;
}

const registry = new Map<string, RegistryEntry>();

async function validateOutboundUrl(url: URL): Promise<boolean> {
  try {
    await assertPublicHttpUrl(url.href);
    return true;
  } catch {
    return false;
  }
}

/**
 * Re-hashes the cached bundle and compares it to the hash recorded when it was installed.
 *
 * The install-time check proves the bytes matched the repository's listing at install;
 * this proves the file on disk is still those bytes. The hash comparison in
 * `getInstalledSandboxedSources` is database-against-memory, so it detects an upstream
 * update but not a local change to the file about to execute. Without this check a
 * truncated, partially copied or edited bundle would run as though it were the reviewed one.
 *
 * Runs only on spawn, where the process fork already dominates the cost.
 */
async function bundleMatchesRecordedHash(row: {
  id: string;
  source_key: string;
  source_code_hash: string;
}): Promise<boolean> {
  try {
    const bytes = await fs.readFile(extensionRepositoryService.getBundlePath(row.id));
    const actual = crypto.createHash('sha256').update(bytes).digest('hex');
    if (actual === row.source_code_hash) {
      return true;
    }
    console.warn(
      `[Extension Registry] Bundle for "${row.source_key}" does not match the hash recorded at install time — refusing to run it. Reinstall the source.`,
    );
    return false;
  } catch (error) {
    console.warn(
      `[Extension Registry] Could not read the bundle for "${row.source_key}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

function buildSource(row: {
  id: string;
  source_key: string;
  name: string;
  lang: string;
  base_url: string;
  is_nsfw: boolean;
  allowed_hosts: unknown;
}): Source & { dispose(): void } {
  return spawnSandboxedSource(
    {
      id: row.source_key,
      name: row.name,
      lang: row.lang,
      base_url: row.base_url,
      isNSFW: row.is_nsfw,
    },
    {
      bundlePath: extensionRepositoryService.getBundlePath(row.id),
      allowedNetHosts: Array.isArray(row.allowed_hosts) ? (row.allowed_hosts as string[]) : [],
      validateOutboundUrl,
      fetchImpl: guardedFetch,
    },
  );
}

/** Returns every enabled installed extension as a plain `Source`, respawning a process
 * only for a row that's new or whose bundle changed since it was last spawned (an
 * "update" always gets a fresh process — never reuses a stale one still running the old
 * code) and disposing anything removed, disabled, or superseded.
 *
 * Every source's identity is presented to the rest of the app as `source_key`
 * (`buildSource`, above), and `installed_extensions` is unique on
 * `(repository_id, source_key)`, not on `source_key` alone — two repositories can each
 * publish "mangadex", and both can be installed. An ambiguous id would make by-id lookups
 * downstream non-deterministic, and `manga.source` could no longer identify which source
 * a stored row came from. A colliding row is therefore skipped here for every caller;
 * first-installed wins, keeping the choice stable. */
export async function getInstalledSandboxedSources(): Promise<Source[]> {
  const rows = await extensionRepositoryRepository.getInstalledExtensions();
  const rowById = new Map(rows.map((row) => [row.id, row]));

  for (const [id, entry] of registry) {
    const row = rowById.get(id);
    if (!row || !row.enabled || row.source_code_hash !== entry.sourceCodeHash) {
      entry.source.dispose();
      registry.delete(id);
    }
  }

  const sources: Source[] = [];
  const seenIds = new Set<string>();
  for (const row of rows) {
    if (!row.enabled) {
      continue;
    }
    if (seenIds.has(row.source_key)) {
      console.warn(
        `[Extension Registry] Source id "${row.source_key}" is already provided by another installed source — ignoring the duplicate`,
      );
      continue;
    }

    let entry = registry.get(row.id);
    if (!entry) {
      // Skipped rather than thrown: one tampered or truncated bundle should cost the user
      // that source, not the whole source list.
      if (!(await bundleMatchesRecordedHash(row))) {
        continue;
      }
      entry = { source: buildSource(row), sourceCodeHash: row.source_code_hash };
      registry.set(row.id, entry);
    }
    seenIds.add(row.source_key);
    sources.push(entry.source);
  }
  return sources;
}

/** The one enabled installed extension whose `source_key` matches, or `undefined`.
 *
 * A thin wrapper over `getInstalledSandboxedSources()` rather than a separate DB query:
 * the collision rule above has to run either way, since a second row could exist for the
 * same key even though only one may ever be returned. */
export async function getInstalledSandboxedSource(sourceKey: string): Promise<Source | undefined> {
  return (await getInstalledSandboxedSources()).find((source) => source.id === sourceKey);
}

/** Called on server shutdown so no sandboxed child process outlives the parent. */
export function disposeAllSandboxedSources(): void {
  for (const entry of registry.values()) {
    entry.source.dispose();
  }
  registry.clear();
}
