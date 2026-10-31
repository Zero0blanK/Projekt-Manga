import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { crc32 } from 'node:zlib';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import downloadService from '../src/services/download.service.js';
import { NotFoundError } from '../src/utils/customErrors.js';
import { writeStoredZip } from '../src/utils/storedZip.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-cbz-'));
const pageOne = path.join(dir, 'page_1.jpg');
const pageTwo = path.join(dir, 'page_2.png');
fs.writeFileSync(pageOne, Buffer.from('first page bytes'));
fs.writeFileSync(pageTwo, Buffer.alloc(70_000, 7)); // larger than one stream chunk

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

/** Reads a ZIP back through its central directory, checking every entry's CRC. */
function readZip(zip: Buffer) {
  const end = zip.length - 22;
  expect(zip.readUInt32LE(end)).toBe(0x06054b50);
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const entries: Array<{ name: string; data: Buffer }> = [];
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50);
    expect(zip.readUInt16LE(at + 10)).toBe(0); // stored
    const crc = zip.readUInt32LE(at + 16);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const offset = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    expect(zip.readUInt32LE(offset)).toBe(0x04034b50);
    const dataStart = offset + 30 + zip.readUInt16LE(offset + 26);
    const data = zip.subarray(dataStart, dataStart + size);
    expect(crc32(data)).toBe(crc);
    entries.push({ name, data });
    at += 46 + nameLength;
  }
  return entries;
}

describe('writeStoredZip', () => {
  it('writes a readable archive with the pages in order', async () => {
    const out = new PassThrough();
    const chunks: Buffer[] = [];
    out.on('data', (chunk: Buffer) => chunks.push(chunk));
    await writeStoredZip(
      [
        { name: 'page_001.jpg', path: pageOne },
        { name: 'page_002.png', path: pageTwo },
      ],
      out,
    );
    out.end();
    const entries = readZip(Buffer.concat(chunks));
    expect(entries.map((e) => e.name)).toEqual(['page_001.jpg', 'page_002.png']);
    expect(entries[0].data.toString()).toBe('first page bytes');
    expect(entries[1].data.length).toBe(70_000);
  });
});

describe('GET /api/downloads/chapter/:chapterId/cbz', () => {
  it('streams the downloaded chapter as a named CBZ', async () => {
    vi.spyOn(downloadService, 'getDownloadedChapterArchive').mockResolvedValue({
      fileName: 'Frieren: Beyond "Journey" - ch12.cbz',
      entries: [
        { name: 'page_001.jpg', path: pageOne },
        { name: 'page_002.png', path: pageTwo },
      ],
    });
    const res = await request(app)
      .get('/api/downloads/chapter/chapter-1/cbz')
      .buffer(true)
      .parse((response, done) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => done(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/vnd.comicbook+zip');
    // Characters Windows forbids in file names are replaced, quotes can't end the header.
    expect(res.headers['content-disposition']).toContain(
      'filename="Frieren Beyond Journey - ch12.cbz"',
    );
    expect(readZip(res.body as Buffer)).toHaveLength(2);
  });

  it('is a 404 when the chapter is not downloaded', async () => {
    vi.spyOn(downloadService, 'getDownloadedChapterArchive').mockRejectedValue(
      new NotFoundError('Chapter not downloaded or path not available'),
    );
    const res = await request(app).get('/api/downloads/chapter/missing/cbz');
    expect(res.status).toBe(404);
  });
});
