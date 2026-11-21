import { SuwayomiError, suwayomiGraphql } from '../client.js';
import { engineProcess } from './process.js';

/**
 * The built-in engine's extension repositories: the indexes its extensions are listed
 * from. None is built in; the user adds the ones they want themselves.
 *
 * Suwayomi-Server 2.4 calls them extension stores and keeps them in its own database:
 * each is added with `addExtensionStore` (which fetches and checks its index, so a wrong
 * URL fails at once) and removed with `removeExtensionStore`. The older `extensionRepos`
 * setting is only read there to migrate old configurations, so it is not used here.
 */

export interface EngineRepository {
  url: string;
  /** The name the repository gives itself in its index. */
  name: string;
}

function connection() {
  const current = engineProcess.currentConnection();
  if (!current) throw new SuwayomiError('NETWORK_ERROR', "The extension engine isn't running");
  return current;
}

export async function getEngineRepositories(): Promise<EngineRepository[]> {
  const data = await suwayomiGraphql<{
    extensionStores: { nodes: Array<{ indexUrl: string; name: string | null }> };
  }>('query { extensionStores { nodes { indexUrl name } } }', {}, connection());
  return data.extensionStores.nodes.map((store) => ({
    url: store.indexUrl,
    name: store.name || store.indexUrl,
  }));
}

/** Makes the engine's repositories exactly `urls`: adds the new ones, removes the rest. */
export async function setEngineRepositories(urls: string[]): Promise<EngineRepository[]> {
  const wanted = [...new Set(urls.map((url) => url.trim()))];
  const current = await getEngineRepositories();
  for (const store of current) {
    if (wanted.includes(store.url)) continue;
    await suwayomiGraphql(
      `mutation RemoveRepository($url: String!) {
        removeExtensionStore(input: { indexUrl: $url }) { extensionStore { indexUrl } }
      }`,
      { url: store.url },
      connection(),
    );
  }
  for (const url of wanted) {
    if (current.some((store) => store.url === url)) continue;
    await suwayomiGraphql(
      `mutation AddRepository($url: String!) {
        addExtensionStore(input: { indexUrl: $url }) { extensionStore { indexUrl } }
      }`,
      { url },
      connection(),
    );
  }
  return getEngineRepositories();
}
