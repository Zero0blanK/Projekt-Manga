import { renameSync, rmSync, writeFileSync, type WriteFileOptions } from 'node:fs';

/** Replaces a file in one step, so a crash mid-write leaves the old file, not half a new
 * one. A truncated session cache would sign the reader out for no visible reason. */
export function writeFileAtomic(
  file: string,
  data: string | Uint8Array,
  options?: WriteFileOptions,
): void {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, data, options);
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
