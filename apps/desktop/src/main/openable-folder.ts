import path from 'node:path';
import { promises as fs } from 'node:fs';

const NETWORK_PATH = /^[\\/]{2}/;

/**
 * Validates a renderer-supplied path before it reaches `shell.openPath`.
 *
 * `shell.openPath` opens a path "in the desktop's default manner", which for an .exe,
 * .bat, .lnk or .hta means *running* it, and for a UNC path (\\host\share\x.exe) means
 * fetching and running a remote file. Only an existing local directory is accepted, after
 * resolving links, so a folder link can't point somewhere else either.
 */
export async function resolveOpenableFolder(rawPath: unknown): Promise<string> {
  if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
    throw new Error('No path provided');
  }
  if (!path.isAbsolute(rawPath) || NETWORK_PATH.test(rawPath)) {
    throw new Error('Only local folders can be opened');
  }

  let target: string;
  try {
    target = await fs.realpath(path.resolve(rawPath));
  } catch {
    throw new Error('That folder no longer exists');
  }
  if (NETWORK_PATH.test(target) || !(await fs.stat(target)).isDirectory()) {
    throw new Error('Only local folders can be opened');
  }
  return target;
}
