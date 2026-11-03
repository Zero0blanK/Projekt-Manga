import type { Source } from '@projekt-manga/types';
import { getInstalledSandboxedSource } from './sandboxedSourceRegistry.service.js';
import { getSuwayomiSource, isSuwayomiSourceId } from './suwayomi/registry.js';

/** The source with this id: a connected Suwayomi server's (ids starting `suwayomi-`, which
 * no extension may use) or an installed extension's. The one lookup every source call and
 * download goes through. */
export async function resolveSource(sourceId: string): Promise<Source | undefined> {
  if (isSuwayomiSourceId(sourceId)) return getSuwayomiSource(sourceId);
  return getInstalledSandboxedSource(sourceId);
}
