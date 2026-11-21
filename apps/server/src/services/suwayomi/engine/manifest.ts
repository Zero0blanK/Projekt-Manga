/**
 * What the extension engine is made of, pinned to versions that were tested together.
 *
 * The engine is Suwayomi-Server's jar run on an Eclipse Temurin Java runtime. Neither is
 * bundled: both are downloaded from their upstream releases, unmodified, only when the
 * user asks for it in Settings. "Check for updates" compares against the latest release;
 * nothing updates by itself.
 */

/** A Suwayomi-Server release: its jar, and the SHA-256 GitHub publishes for it. */
export interface ServerRelease {
  /** The release tag, e.g. "v2.4.2366". Also the folder name it is installed under. */
  version: string;
  /** The jar's asset name in that release. */
  asset: string;
  /** SHA-256 of the jar, lowercase hex. */
  sha256: string;
  size: number;
}

/** The release this build of Projekt Manga was tested with. */
export const PINNED_SERVER: ServerRelease = {
  version: 'v2.4.2366',
  asset: 'Suwayomi-Server-v2.4.2366.jar',
  sha256: 'af9feb20af9d7ebe9e30769e6c6ebc7fc7ab1c447388d42e0280b1da5fe07bfd',
  size: 182_952_426,
};

/** The Java major version Suwayomi-Server targets (its `jvmTarget`). */
export const JAVA_MAJOR = 21;

/** Where Suwayomi-Server's releases are published. */
export const SERVER_REPOSITORY = 'Suwayomi/Suwayomi-Server';

/** Licenses shown in Settings beside the Download button. */
export const LICENSES = [
  {
    name: 'Suwayomi-Server',
    license: 'MPL-2.0',
    url: 'https://github.com/Suwayomi/Suwayomi-Server/blob/master/LICENSE',
  },
  {
    name: 'Eclipse Temurin',
    license: 'GPL-2.0 with the Classpath Exception',
    url: 'https://adoptium.net/about/',
  },
] as const;

/** A platform as Adoptium names it. */
export interface RuntimePlatform {
  os: 'windows' | 'mac' | 'linux' | 'alpine-linux';
  arch: 'x64' | 'aarch64';
}

/** Whether this Linux uses musl (Alpine) rather than glibc. */
function usesMusl(): boolean {
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } };
  return !report?.header?.glibcVersionRuntime;
}

/** The runtime build for this machine, or null where Temurin offers none. */
export function runtimePlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  musl: () => boolean = usesMusl,
): RuntimePlatform | null {
  const cpu = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'aarch64' : null;
  if (!cpu) return null;
  if (platform === 'win32') return { os: 'windows', arch: cpu };
  if (platform === 'darwin') return { os: 'mac', arch: cpu };
  if (platform === 'linux') return { os: musl() ? 'alpine-linux' : 'linux', arch: cpu };
  return null;
}

/** Adoptium's API for the latest JRE of a major version on a platform. */
export function runtimeAssetsUrl(platform: RuntimePlatform, major = JAVA_MAJOR): URL {
  const url = new URL(`https://api.adoptium.net/v3/assets/latest/${major}/hotspot`);
  url.searchParams.set('architecture', platform.arch);
  url.searchParams.set('image_type', 'jre');
  url.searchParams.set('os', platform.os);
  url.searchParams.set('vendor', 'eclipse');
  return url;
}
