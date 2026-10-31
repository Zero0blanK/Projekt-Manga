/**
 * A ZIP written without compression ("stored"), for exporting a downloaded chapter as a
 * CBZ. Page images are already compressed, so deflating them again costs time and saves
 * nothing, and storing keeps this small enough not to need a dependency.
 *
 * Files are read one at a time and written as they are read, so memory stays at one page.
 * No ZIP64: a chapter is far below the 4 GiB a plain ZIP allows, and the writer refuses
 * anything that would need it rather than produce a broken archive.
 */
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import type { Writable } from 'node:stream';
import { crc32 } from 'node:zlib';

export interface StoredZipEntry {
  /** The name inside the archive (ASCII, no directories). */
  name: string;
  /** The file to read it from. */
  path: string;
}

const LIMIT = 0xffffffff;
/** 1 January 1980, the earliest date a ZIP can hold: entries carry no meaningful time. */
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

async function write(out: Writable, chunk: Buffer): Promise<void> {
  if (!out.write(chunk)) await once(out, 'drain');
}

export async function writeStoredZip(entries: StoredZipEntry[], out: Writable): Promise<void> {
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = await readFile(entry.path);
    if (data.length >= LIMIT || offset + data.length + 30 + name.length >= LIMIT)
      throw new Error('Chapter too large to export as a CBZ');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header
    local.writeUInt16LE(20, 4); // version needed: 2.0
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra field length

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0); // central directory header
    header.writeUInt16LE(20, 4); // version made by
    header.writeUInt16LE(20, 6); // version needed
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(DOS_TIME, 12);
    header.writeUInt16LE(DOS_DATE, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(name.length, 28);
    // extra, comment, disk start, internal and external attributes: all zero
    header.writeUInt32LE(offset, 42);
    central.push(header, name);

    await write(out, local);
    await write(out, name);
    await write(out, data);
    offset += local.length + name.length + data.length;
  }

  const directory = Buffer.concat(central);
  if (entries.length > 0xffff || offset + directory.length >= LIMIT)
    throw new Error('Chapter too large to export as a CBZ');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory
  end.writeUInt16LE(entries.length, 8); // entries on this disk
  end.writeUInt16LE(entries.length, 10); // entries in total
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  await write(out, directory);
  await write(out, end);
}
