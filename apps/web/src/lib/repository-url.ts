/** The project's own source repository, offered as a one-click start. */
export const PROJEKTMANGA_SOURCES_URL =
  'https://raw.githubusercontent.com/Zero0blanK/projektmanga-sources/main/index.json';

/** Returns a reason the text can't be a repository URL, or null when it can. */
export function repositoryUrlProblem(text: string): string | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return 'Enter the full address, starting with https://.';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return 'Use an https:// address.';
  }
  return null;
}

/** Hosts whose first path segment is the account that owns the repository. */
const OWNER_PATH_HOSTS = new Set([
  'github.com',
  'raw.githubusercontent.com',
  'gitlab.com',
  'codeberg.org',
  'bitbucket.org',
]);

function ownerFromUrl(text: string | null | undefined): string | null {
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (OWNER_PATH_HOSTS.has(host)) {
    const owner = url.pathname.split('/').find(Boolean);
    return owner ? decodeURIComponent(owner) : null;
  }
  // GitHub Pages: <owner>.github.io
  const pages = host.match(/^([^.]+)\.github\.io$/);
  return pages ? pages[1] : null;
}

/** Who publishes a repository's sources: the owning account on a known code host (from the
 * repository's own address first, then its website), else the name the repository gives
 * itself, else its address. */
export function repositoryPublisher(repository: {
  url: string;
  website?: string | null;
  name?: string | null;
}): string {
  return (
    ownerFromUrl(repository.url) ??
    ownerFromUrl(repository.website) ??
    (repository.name || repository.url)
  );
}
