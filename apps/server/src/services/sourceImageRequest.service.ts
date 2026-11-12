import { installedExtensionFor } from '@projekt-manga/types';
import extensionRepository from '../repositories/extensionRepository.repository.js';
import { hasImageReferer } from '../utils/userAgent.js';

/**
 * What the image proxy and the cover cache share about asking a source's image host for a
 * picture: some refuse the first request, and many only serve hotlinks from their own site.
 */

/** Statuses a CDN gives a pooled or hotlinked request that a fresh retry often gets past. */
export const RETRYABLE_UPSTREAM_STATUSES = new Set([403, 503]);
export const UPSTREAM_RETRY_DELAY_MS = 300;

/** The installed source's own site, as a Referer for a retried image request. */
export async function sourceReferer(sourceId: string): Promise<Record<string, string>> {
  if (!sourceId || hasImageReferer(sourceId)) return {};
  try {
    const installed = installedExtensionFor(
      await extensionRepository.getInstalledExtensions(),
      sourceId,
    );
    const site = installed?.homepage || installed?.base_url;
    return site ? { Referer: `${new URL(site).origin}/` } : {};
  } catch {
    return {};
  }
}
