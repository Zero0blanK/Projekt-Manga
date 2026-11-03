import { absoluteSuwayomiUrl, requireConnection, suwayomiGraphql } from './client.js';
import { forgetSuwayomiSourceList } from './registry.js';

/**
 * The Mihon extensions the host's Suwayomi server can install: every one in its extension
 * repositories, not just the installed ones, so Discover › Extensions can install, update
 * and remove them there. Installing runs nothing here; Suwayomi does it, and the sources it
 * adds appear beside the installed extensions.
 */

export interface SuwayomiExtension {
  pkg_name: string;
  name: string;
  lang: string;
  version: string;
  icon_url: string | null;
  is_nsfw: boolean;
  installed: boolean;
  has_update: boolean;
  obsolete: boolean;
}

export type SuwayomiExtensionAction = 'install' | 'update' | 'uninstall';

const FIELDS = 'pkgName name lang versionName iconUrl isNsfw isInstalled hasUpdate isObsolete';

interface ExtensionNode {
  pkgName: string;
  name: string;
  lang: string;
  versionName?: string | null;
  iconUrl?: string | null;
  isNsfw?: boolean | null;
  isInstalled?: boolean | null;
  hasUpdate?: boolean | null;
  isObsolete?: boolean | null;
}

const PKG = /^[A-Za-z0-9_.]{1,200}$/;

function toExtension(node: ExtensionNode): SuwayomiExtension | null {
  if (!node || typeof node.pkgName !== 'string' || !PKG.test(node.pkgName)) return null;
  // Suwayomi names a Mihon extension "Tachiyomi: <Name>"; the prefix says nothing here.
  const name = String(node.name ?? node.pkgName).replace(/^Tachiyomi:\s*/, '');
  return {
    pkg_name: node.pkgName,
    name,
    lang: typeof node.lang === 'string' ? node.lang : 'all',
    version: typeof node.versionName === 'string' ? node.versionName : '',
    icon_url: absoluteSuwayomiUrl(node.iconUrl, requireConnection()) || null,
    is_nsfw: node.isNsfw === true,
    installed: node.isInstalled === true,
    has_update: node.hasUpdate === true,
    obsolete: node.isObsolete === true,
  };
}

const sorted = (nodes: ExtensionNode[]) =>
  nodes
    .map(toExtension)
    .filter((extension): extension is SuwayomiExtension => extension !== null)
    .sort((a, b) => a.name.localeCompare(b.name));

/** The extension list. `refresh` asks Suwayomi to re-read its repositories first. */
export async function listSuwayomiExtensions(refresh = false): Promise<SuwayomiExtension[]> {
  if (refresh) {
    const data = await suwayomiGraphql<{ fetchExtensions: { extensions: ExtensionNode[] } }>(
      `mutation { fetchExtensions(input: {}) { extensions { ${FIELDS} } } }`,
    );
    return sorted(data.fetchExtensions?.extensions ?? []);
  }
  const data = await suwayomiGraphql<{ extensions: { nodes: ExtensionNode[] } }>(
    `query { extensions { nodes { ${FIELDS} } } }`,
  );
  return sorted(data.extensions?.nodes ?? []);
}

export async function changeSuwayomiExtension(
  pkgName: string,
  action: SuwayomiExtensionAction,
): Promise<SuwayomiExtension | null> {
  const data = await suwayomiGraphql<{ updateExtension: { extension: ExtensionNode | null } }>(
    `mutation ($input: UpdateExtensionInput!) { updateExtension(input: $input) { extension { ${FIELDS} } } }`,
    { input: { id: pkgName, patch: { [action]: true } } },
  );
  // Its sources changed; the next list asks Suwayomi again.
  forgetSuwayomiSourceList();
  const node = data.updateExtension?.extension;
  return node ? toExtension(node) : null;
}
