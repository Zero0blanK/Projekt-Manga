/**
 * Downloads an official Node runtime and stages it for the installer to ship.
 *
 * Why the installer needs its own Node at all: the API child runs the extension sandbox,
 * which requires Node >= 25 because `--allow-net` only became a gated permission in
 * 25.0.0. Below that, omitting the flag restricts nothing, so a sandboxed source would get
 * real unrestricted network access while claiming to be isolated —
 * `spawnSandboxedSource.ts` refuses to run rather than pretend. Electron's bundled Node is
 * older than 25, so `ELECTRON_RUN_AS_NODE` cannot satisfy that and every installed source
 * would fail on first use.
 *
 * Shipping a second runtime is the cost of keeping the sandbox honest on desktop, and it
 * is sizeable. Only the API child uses it; the shell and the renderer are still Electron's
 * own binary.
 *
 * The download is checksum-verified against nodejs.org's published SHASUMS256.txt, since
 * this file exists to keep unverified code from running.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Pinned deliberately rather than resolved to "latest".
 *
 * A build that silently picks up a new runtime is a build whose output nobody has tested;
 * bumping this should be a visible change with a visible diff. Must stay >= 25 — see the
 * gate in `spawnSandboxedSource.ts`, which is the reason this file exists.
 */
export const NODE_VERSION = '25.9.0';

const BASE_URL = `https://nodejs.org/dist/v${NODE_VERSION}`;

/** Node's own release naming, which is what the download URLs are built from. */
function platformTriple(platform = process.platform, arch = process.arch) {
  const os = { win32: 'win', darwin: 'darwin', linux: 'linux' }[platform];
  if (!os) throw new Error(`No official Node build for platform "${platform}"`);

  const cpu = { x64: 'x64', arm64: 'arm64' }[arch];
  if (!cpu) throw new Error(`No official Node build for architecture "${arch}"`);

  // Windows releases are zip, the rest tar.gz — Node publishes no tarball for Windows.
  // Which extractor can read which is not uniform; see tarBinary().
  return { name: `node-v${NODE_VERSION}-${os}-${cpu}`, ext: os === 'win' ? 'zip' : 'tar.gz' };
}

/** Path of the `node` executable *inside* an extracted release directory. */
function binaryWithin(dir, platform = process.platform) {
  return platform === 'win32' ? path.join(dir, 'node.exe') : path.join(dir, 'bin', 'node');
}

/**
 * The extractor to use, resolved rather than left to PATH.
 *
 * Windows releases are zip, and only bsdtar reads those — Windows has shipped it as
 * `System32\tar.exe` since 10 1803, but a shell whose PATH prefers Git's GNU tar (as Git
 * Bash does) would otherwise win and fail with a confusing "unrecognized archive format".
 * Naming the system one keeps the result independent of which shell ran the build.
 */
function tarBinary(platform) {
  if (platform !== 'win32') return 'tar';

  const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  if (fs.existsSync(system)) return system;

  throw new Error(
    `Extracting the Node runtime needs ${system}, which this machine does not have. ` +
      'It ships with Windows 10 1803 and newer.',
  );
}

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Downloading ${url} failed with HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/**
 * The SHA-256 nodejs.org publishes for one release file.
 *
 * SHASUMS256.txt is fetched over HTTPS from the same host as the archive, so this proves
 * the bytes arrived intact, not who produced them — that would need the signed
 * SHASUMS256.txt.sig and a trusted key, which this does not attempt. It still catches the
 * realistic failure: a truncated or corrupted download becoming the runtime that runs the
 * server.
 */
async function publishedChecksum(fileName) {
  const text = (await download(`${BASE_URL}/SHASUMS256.txt`)).toString('utf-8');
  const line = text.split('\n').find((l) => l.trim().endsWith(` ${fileName}`));
  if (!line) {
    throw new Error(`SHASUMS256.txt for v${NODE_VERSION} has no entry for ${fileName}`);
  }
  return line.trim().split(/\s+/)[0];
}

/**
 * Ensures a verified Node binary exists in `cacheDir`, downloading it once.
 *
 * Cached because the archive is tens of megabytes and `npm run stage` is run repeatedly
 * while iterating on the installer; keyed by version and platform so a cache entry can
 * never be the wrong build.
 */
export async function fetchNodeBinary(cacheDir, platform = process.platform, arch = process.arch) {
  const { name, ext } = platformTriple(platform, arch);
  const extracted = path.join(cacheDir, name);
  const cachedBinary = binaryWithin(extracted, platform);

  if (fs.existsSync(cachedBinary)) {
    console.log(`[stage] node runtime: using cached ${name}`);
    return cachedBinary;
  }

  const fileName = `${name}.${ext}`;
  console.log(`[stage] node runtime: downloading ${fileName}`);

  const [archive, expected] = await Promise.all([
    download(`${BASE_URL}/${fileName}`),
    publishedChecksum(fileName),
  ]);

  const actual = crypto.createHash('sha256').update(archive).digest('hex');
  if (actual !== expected) {
    throw new Error(
      `Checksum mismatch for ${fileName}\n  expected ${expected}\n  received ${actual}\n` +
        'Refusing to stage it.',
    );
  }
  console.log('[stage] node runtime: checksum verified');

  fs.mkdirSync(cacheDir, { recursive: true });
  const archivePath = path.join(cacheDir, fileName);
  fs.writeFileSync(archivePath, archive);

  // Run from inside the cache directory with a bare filename, rather than passing absolute
  // paths: GNU tar reads `C:\...` as a remote `host:path` and fails with
  // "Cannot connect to C: resolve failed".
  //
  // The release archives all contain a single top-level directory named after the release,
  // which is what `extracted` points at.
  execFileSync(tarBinary(platform), ['-xf', fileName], { cwd: cacheDir, stdio: 'inherit' });
  fs.rmSync(archivePath, { force: true });

  if (!fs.existsSync(cachedBinary)) {
    throw new Error(`Extracted ${fileName} but found no executable at ${cachedBinary}`);
  }
  return cachedBinary;
}

/**
 * Copies the runtime into the staging tree as `node/<binary>`.
 *
 * Only the executable is copied, not the whole release: the API is run as
 * `node <entry>`, which needs nothing else from the tarball. Shipping the rest would add
 * npm, corepack, headers and docs to the installer for no reason.
 */
export async function stageNodeRuntime(stagingDir, cacheDir) {
  const platform = process.env.PROJEKT_MANGA_TARGET_PLATFORM || process.platform;
  const arch = process.env.PROJEKT_MANGA_TARGET_ARCH || process.arch;

  const source = await fetchNodeBinary(cacheDir, platform, arch);
  const destDir = path.join(stagingDir, 'node');
  fs.mkdirSync(destDir, { recursive: true });

  const dest = path.join(destDir, path.basename(source));
  fs.copyFileSync(source, dest);
  // cpSync/copyFileSync preserve mode on POSIX, but be explicit: a runtime that is not
  // executable fails at spawn time with a bare EACCES, long after this step.
  if (platform !== 'win32') fs.chmodSync(dest, 0o755);

  console.log(`[stage] node runtime: staged v${NODE_VERSION} (${platform}-${arch}) -> ${dest}`);
  return dest;
}
