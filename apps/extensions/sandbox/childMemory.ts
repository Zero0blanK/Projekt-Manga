import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);
const LINUX_PAGE_BYTES = 4096;

/**
 * A process's resident memory, or null when it can't be read.
 *
 * `--max-old-space-size` caps the JavaScript heap only: Buffers and ArrayBuffers sit outside
 * it, and Node's permission model has no memory limit. Asking the OS is the one measure a
 * source can't get around from inside its own process.
 */
export async function residentBytes(pid: number): Promise<number | null> {
  try {
    if (process.platform === 'linux') {
      const statm = await readFile(`/proc/${pid}/statm`, 'utf8');
      const pages = Number(statm.split(' ')[1]);
      return Number.isFinite(pages) ? pages * LINUX_PAGE_BYTES : null;
    }
    if (process.platform === 'win32') {
      const { stdout } = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        timeout: 5000,
        windowsHide: true,
      });
      // "node.exe","1234","Console","1","123,456 K"
      const kilobytes = /"([\d.,\s]+) K"/.exec(stdout)?.[1].replace(/\D/g, '');
      return kilobytes ? Number(kilobytes) * 1024 : null;
    }
    const { stdout } = await run('ps', ['-o', 'rss=', '-p', String(pid)], { timeout: 5000 });
    const kilobytes = Number(stdout.trim());
    return Number.isFinite(kilobytes) && kilobytes > 0 ? kilobytes * 1024 : null;
  } catch {
    return null;
  }
}
