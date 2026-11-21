import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * Unpacks the Java runtime's archive with the system's own `tar`, which reads .tar.gz
 * everywhere and .zip on Windows (its tar is bsdtar), so no unpacking code ships with the
 * app. The archive has already passed its checksum; these checks are a second line:
 * the entry list is read first and refused if any name is absolute or climbs out with
 * "..", and after unpacking every symbolic link must point inside the folder.
 */

const TAR_TIMEOUT_MS = 5 * 60_000;

/** The system tar. On Windows the one in System32, not a GNU tar from a Git install,
 * which reads no .zip and misreads drive letters as remote hosts. */
function tarCommand(): string {
  if (process.platform !== 'win32') return 'tar';
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
}

function run(args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(tarCommand(), args, { windowsHide: true, signal });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill(), TAR_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      err = (err + chunk.toString('utf8')).slice(-2000);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`tar failed (${code}): ${err.trim().split('\n').pop() ?? ''}`));
    });
  });
}

/** Whether an archive entry name is safe to unpack under a folder. */
export function isSafeEntryName(name: string): boolean {
  const normalized = name.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return false;
  return !normalized.split('/').some((segment) => segment === '..');
}

async function checkLinks(root: string, dir: string): Promise<void> {
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      const target = path.resolve(dir, await fsp.readlink(full));
      const relative = path.relative(root, target);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`The archive links outside its folder: ${entry.name}`);
      }
    } else if (entry.isDirectory()) {
      await checkLinks(root, full);
    }
  }
}

/** Unpacks `archive` into `destination` (created, and expected to be empty). */
export async function unpack(
  archive: string,
  destination: string,
  signal?: AbortSignal,
): Promise<void> {
  const names = (await run(['-tf', archive], signal)).split(/\r?\n/).filter(Boolean);
  if (names.length === 0) throw new Error('The archive is empty');
  const unsafe = names.find((name) => !isSafeEntryName(name));
  if (unsafe) throw new Error(`The archive has an unsafe entry: ${unsafe}`);
  await fsp.mkdir(destination, { recursive: true });
  await run(['-xf', archive, '-C', destination], signal);
  await checkLinks(path.resolve(destination), path.resolve(destination));
}

/** Finds the `java` executable in an unpacked runtime (bin/ at the top, under one folder,
 * or under Contents/Home on macOS). */
export async function findJava(runtimeDir: string): Promise<string | null> {
  const exe = process.platform === 'win32' ? 'java.exe' : 'java';
  const candidates = [path.join(runtimeDir, 'bin', exe)];
  try {
    for (const entry of await fsp.readdir(runtimeDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      candidates.push(path.join(runtimeDir, entry.name, 'bin', exe));
      candidates.push(path.join(runtimeDir, entry.name, 'Contents', 'Home', 'bin', exe));
    }
  } catch {
    return null;
  }
  for (const candidate of candidates) {
    try {
      if ((await fsp.stat(candidate)).isFile()) return candidate;
    } catch {
      // Not this one.
    }
  }
  return null;
}
