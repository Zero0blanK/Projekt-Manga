import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { replaceBackupBodySchema } from '@projekt-manga/schemas';
import {
  buildMihonImport,
  decodeMihonBackup,
  guessSlug,
  mapStatus,
  mapTracking,
  matchSource,
  normaliseSourceName,
  readMihonBackupFile,
  resolveMihonKeys,
  summariseSources,
  MihonBackupError,
  type MihonBackup,
  type SourceKeys,
} from '@/lib/mihon-backup';
import { parseBackup } from '@/lib/backup-validation';

// A minimal protobuf writer, so every test builds its own backup bytes.
type Field = Uint8Array;
const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};
const varint = (value: bigint | number) => {
  let v = BigInt.asUintN(64, BigInt(value));
  const bytes: number[] = [];
  while (v >= 0x80n) {
    bytes.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  bytes.push(Number(v));
  return Uint8Array.from(bytes);
};
const tag = (field: number, wire: number) => varint((field << 3) | wire);
const int = (field: number, value: bigint | number | boolean): Field =>
  concat([tag(field, 0), varint(typeof value === 'boolean' ? (value ? 1 : 0) : value)]);
const bytes = (field: number, value: Uint8Array): Field =>
  concat([tag(field, 2), varint(value.length), value]);
const str = (field: number, value: string) => bytes(field, new TextEncoder().encode(value));
const msg = (field: number, ...fields: Field[]) => bytes(field, concat(fields));
const float = (field: number, value: number): Field => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setFloat32(0, value, true);
  return concat([tag(field, 5), out]);
};
const fixed64 = (field: number): Field => concat([tag(field, 1), new Uint8Array(8)]);

const BIG_SOURCE = 6400665728063187402n; // needs all 63 bits

function sampleBackup(): Uint8Array {
  const chapter = (url: string, n: number, extra: Field[] = []) =>
    msg(16, str(1, url), str(2, `Chapter ${n}`), float(9, n), int(8, 1_700_000_000_000), ...extra);
  return concat([
    msg(
      1,
      int(1, BIG_SOURCE),
      str(2, '/manga/one-piece/'),
      str(3, 'One Piece'),
      str(4, 'Oda'),
      str(5, 'Eiichiro Oda'),
      str(6, 'Pirates.'),
      str(7, 'Action'),
      str(7, 'Adventure'),
      int(8, 1),
      str(9, 'https://example.org/cover.jpg'),
      int(13, 1_600_000_000_000),
      chapter('/manga/one-piece/chapter-1/', 1, [int(4, true), int(3, 0)]),
      chapter('/manga/one-piece/chapter-2/', 2, [int(5, true), int(6, 7), str(3, 'Team')]),
      chapter('/manga/one-piece/chapter-3/', 3),
      // Packed category orders.
      bytes(17, concat([varint(1), varint(2)])),
      msg(18, int(1, 2), int(100, 30013), str(4, 'https://anilist.co/manga/30013')),
      msg(18, int(1, 99), int(100, 5)),
      msg(104, str(1, '/manga/one-piece/chapter-2/'), int(2, 1_700_000_100_000), int(3, 5)),
      // Unknown fields of every wire type must be skipped.
      int(500, 42),
      fixed64(501),
      str(502, 'future'),
      float(503, 1.5),
    ),
    msg(1, int(1, 77), str(2, '/series/abc'), str(3, 'Lost Title'), int(100, true)),
    msg(1, int(1, BIG_SOURCE), str(2, '/manga/history-only/'), str(3, 'Browsed'), int(100, false)),
    msg(2, str(1, 'Reading'), int(2, 1)),
    msg(2, str(1, 'Weekly'), int(2, 2), int(100, 5)),
    msg(101, str(1, 'Madara Site'), int(2, BIG_SOURCE)),
    msg(101, str(1, 'Gone Source'), int(2, 77)),
    str(103, 'preferences are ignored'),
  ]);
}

describe('decodeMihonBackup', () => {
  it('reads the imported fields and skips unknown ones', () => {
    const backup = decodeMihonBackup(sampleBackup());
    expect(backup.sources).toEqual([
      { id: BIG_SOURCE.toString(), name: 'Madara Site' },
      { id: '77', name: 'Gone Source' },
    ]);
    expect(backup.categories).toEqual([
      { name: 'Reading', order: 1 },
      { name: 'Weekly', order: 2 },
    ]);
    const [manga] = backup.manga;
    expect(manga).toMatchObject({
      source: BIG_SOURCE.toString(),
      url: '/manga/one-piece/',
      title: 'One Piece',
      artist: 'Oda',
      author: 'Eiichiro Oda',
      description: 'Pirates.',
      genres: ['Action', 'Adventure'],
      status: 1,
      thumbnailUrl: 'https://example.org/cover.jpg',
      dateAdded: 1_600_000_000_000,
      favorite: true,
      categories: [1, 2],
      history: [{ url: '/manga/one-piece/chapter-2/', lastRead: 1_700_000_100_000 }],
    });
    expect(manga.chapters).toHaveLength(3);
    expect(manga.chapters[0]).toMatchObject({ read: true, bookmark: false, chapterNumber: 1 });
    expect(manga.chapters[1]).toMatchObject({
      read: false,
      bookmark: true,
      lastPageRead: 7,
      scanlator: 'Team',
      dateUpload: 1_700_000_000_000,
    });
    expect(manga.tracking).toEqual([
      { syncId: 2, mediaId: '30013', trackingUrl: 'https://anilist.co/manga/30013', title: '' },
      { syncId: 99, mediaId: '5', trackingUrl: '', title: '' },
    ]);
    expect(backup.manga[2].favorite).toBe(false);
  });

  it('accepts unpacked repeated category orders', () => {
    const backup = decodeMihonBackup(msg(1, str(3, 'A'), int(17, 3), int(17, 4)));
    expect(backup.manga[0].categories).toEqual([3, 4]);
  });

  it('rejects a truncated file at every cut point', () => {
    const full = sampleBackup();
    for (const cut of [1, 2, 10, Math.floor(full.length / 2), full.length - 1]) {
      expect(() => decodeMihonBackup(full.subarray(0, cut))).toThrow(MihonBackupError);
    }
  });

  it('rejects data that is not a backup', () => {
    expect(() => decodeMihonBackup(new TextEncoder().encode('{"version":2}'))).toThrow(
      MihonBackupError,
    );
    expect(() => decodeMihonBackup(new Uint8Array())).toThrow(/no Mihon library/);
  });

  it('gunzips a .tachibk file', async () => {
    const gzipped = new Uint8Array(gzipSync(sampleBackup()));
    const file = { arrayBuffer: async () => gzipped.buffer } as unknown as Blob;
    const backup = await readMihonBackupFile(file);
    expect(backup.manga).toHaveLength(3);
    const damaged = { arrayBuffer: async () => gzipped.slice(0, 30).buffer } as unknown as Blob;
    await expect(readMihonBackupFile(damaged)).rejects.toThrow(MihonBackupError);
  });
});

describe('source mapping', () => {
  const installed = [
    { id: 'madarasite', name: 'Madara Site', lang: 'en' },
    { id: 'mangadex-en', name: 'MangaDex', lang: 'en' },
    { id: 'mangadex-ja', name: 'MangaDex', lang: 'ja' },
  ];

  it('normalises case, accents, punctuation and language suffixes', () => {
    expect(normaliseSourceName('Mángá-Dex (EN)')).toBe('mangadex');
    expect(normaliseSourceName(' Madara  Site ')).toBe('madarasite');
  });

  it('matches a unique name without looking at the language', () => {
    expect(matchSource('madara site', installed)).toEqual({
      kind: 'matched',
      sourceId: 'madarasite',
    });
  });

  it('uses the language only when the name repeats', () => {
    expect(matchSource('MangaDex (JA)', installed)).toEqual({
      kind: 'matched',
      sourceId: 'mangadex-ja',
    });
    expect(matchSource('MangaDex', installed)).toEqual({
      kind: 'ambiguous',
      candidates: ['mangadex-en', 'mangadex-ja'],
    });
    expect(matchSource('Other', installed)).toEqual({ kind: 'unmatched' });
  });

  it('summarises sources by title count, including ones missing from backupSources', () => {
    const backup = decodeMihonBackup(concat([sampleBackup(), msg(1, int(1, 5), str(3, 'X'))]));
    const summary = summariseSources(backup, installed);
    expect(summary.map((s) => [s.name, s.titles, s.match.kind])).toEqual([
      ['Madara Site', 2, 'matched'],
      ['Gone Source', 1, 'unmatched'],
      ['Unknown source 5', 1, 'unmatched'],
    ]);
  });
});

describe('tracker mapping', () => {
  const row = (syncId: number, mediaId: string, trackingUrl = '') => ({
    syncId,
    mediaId,
    trackingUrl,
    title: '',
  });

  it('maps every Mihon tracker id', () => {
    expect([1, 2, 3, 4, 5, 7].map((id) => mapTracking(row(id, '123'))?.tracker)).toEqual([
      'MYANIMELIST',
      'ANILIST',
      'KITSU',
      'SHIKIMORI',
      'BANGUMI',
      'MANGAUPDATES',
    ]);
  });

  it('reads self-hosted series ids from the tracking URL', () => {
    expect(mapTracking(row(6, '999', 'https://komga.lan/api/v1/series/0A1B2C3D'))).toEqual({
      tracker: 'KOMGA',
      tracker_media_id: '0A1B2C3D',
    });
    expect(mapTracking(row(6, '999'))).toBeNull();
    expect(mapTracking(row(8, '42', 'https://kavita.lan/api/Series/17'))).toEqual({
      tracker: 'KAVITA',
      tracker_media_id: '17',
    });
    expect(mapTracking(row(8, '42'))).toEqual({ tracker: 'KAVITA', tracker_media_id: '42' });
  });

  it('drops unknown trackers and empty ids', () => {
    expect(mapTracking(row(9, '1'))).toBeNull();
    expect(mapTracking(row(2, '0'))).toBeNull();
    expect(mapTracking(row(2, ''))).toBeNull();
  });

  it('maps statuses', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 9].map(mapStatus)).toEqual([
      'UNKNOWN',
      'ONGOING',
      'COMPLETED',
      'UNKNOWN',
      'COMPLETED',
      'CANCELLED',
      'HIATUS',
      'UNKNOWN',
    ]);
  });
});

const madaraKeys = (backup: MihonBackup): Map<string, SourceKeys> => {
  const keys: SourceKeys = { supported: true, manga: new Map(), chapters: new Map() };
  for (const title of backup.manga) {
    keys.manga.set(title.url, title.url.split('/').filter(Boolean)[1] ?? null);
    for (const chapter of title.chapters)
      keys.chapters.set(chapter.url, chapter.url.split('/').filter(Boolean).pop() ?? null);
  }
  return new Map([[BIG_SOURCE.toString(), keys]]);
};

describe('buildMihonImport', () => {
  const backup = decodeMihonBackup(sampleBackup());
  const sources = new Map<string, string | null>([
    [BIG_SOURCE.toString(), 'madarasite'],
    ['77', null],
  ]);

  it('builds a payload the restore schema and backup validation accept', () => {
    const built = buildMihonImport(backup, {
      sources,
      keys: madaraKeys(backup),
      unmatched: 'skip',
    });
    const body = {
      ...built.payload,
      jobId: crypto.randomUUID(),
      mode: 'merge',
      expectedUserId: null,
    };
    const parsed = replaceBackupBodySchema.parse(body);
    expect(parseBackup(JSON.parse(JSON.stringify(built.payload)))).toBeTruthy();

    expect(parsed.manga).toHaveLength(1);
    const [entry] = parsed.manga;
    expect(entry).toMatchObject({
      source: 'madarasite',
      slug: 'one-piece',
      title: 'One Piece',
      author: 'Eiichiro Oda',
      artist: 'Oda',
      genres: 'Action, Adventure',
      status: 'ONGOING',
      thumbnail_url: 'https://example.org/cover.jpg',
    });
    // The untouched chapter 3 is left for the next chapter sync.
    expect(
      entry.chapters.map((c) => [c.source_chapter_key, c.is_read, c.is_bookmark, c.last_page_read]),
    ).toEqual([
      ['chapter-1', true, false, 0],
      ['chapter-2', false, true, 7],
    ]);
    expect(entry.chapters[1].release_date).toBe(new Date(1_700_000_000_000).toISOString());
    expect(parsed.history).toHaveLength(1);
    expect(parsed.history[0]).toMatchObject({
      source: 'madarasite',
      manga_slug: 'one-piece',
      manga_id: entry.id,
      source_chapter_key: 'chapter-2',
      last_page_read: 7,
      chapter_number: 2,
    });
    expect(built.extras.categories).toEqual([
      { name: 'Reading', titles: [{ source: 'madarasite', slug: 'one-piece' }] },
      { name: 'Weekly', titles: [{ source: 'madarasite', slug: 'one-piece' }] },
    ]);
    expect(built.extras.trackers).toEqual([
      { source: 'madarasite', slug: 'one-piece', tracker: 'ANILIST', tracker_media_id: '30013' },
    ]);
    expect(built.stats).toMatchObject({
      libraryTitles: 1,
      unmatchedSkipped: 1,
      chaptersWithState: 2,
      skippedTrackers: 1,
      guessedSlugs: 0,
    });
  });

  it('adds unmatched titles without chapters when asked', () => {
    const built = buildMihonImport(backup, {
      sources,
      keys: madaraKeys(backup),
      unmatched: 'import',
    });
    const lost = built.payload.manga.find((entry) => entry.title === 'Lost Title');
    expect(lost).toMatchObject({ source: 'mihon:Gone Source', slug: '/series/abc', chapters: [] });
    expect(lost?.thumbnail_url).toBe('none');
    replaceBackupBodySchema.parse({
      ...built.payload,
      jobId: crypto.randomUUID(),
      mode: 'merge',
      expectedUserId: null,
    });
  });

  it('falls back to chapter numbers when the source has no keyFromUrl', () => {
    const built = buildMihonImport(backup, {
      sources,
      keys: new Map([
        [BIG_SOURCE.toString(), { supported: false, manga: new Map(), chapters: new Map() }],
      ]),
      unmatched: 'skip',
    });
    expect(built.payload.manga[0]).toMatchObject({ slug: 'one-piece', chapters: [] });
    expect(built.extras.chapterNumbers).toEqual([
      { source: 'madarasite', slug: 'one-piece', read: [1], lastPage: [[2, 7]] },
    ]);
    expect(built.stats.guessedSlugs).toBe(1);
    expect(built.payload.history[0].source_chapter_key).toBeNull();
    replaceBackupBodySchema.parse({
      ...built.payload,
      jobId: crypto.randomUUID(),
      mode: 'merge',
      expectedUserId: null,
    });
  });

  it('guesses slugs from the last path segment', () => {
    expect(guessSlug('/title/a1b2-c3?lang=en')).toBe('a1b2-c3');
    expect(guessSlug('/manga/caf%C3%A9/')).toBe('café');
    expect(guessSlug('/')).toBeNull();
  });
});

describe('resolveMihonKeys', () => {
  const backup = decodeMihonBackup(sampleBackup());
  const sources = new Map<string, string | null>([[BIG_SOURCE.toString(), 'madarasite']]);

  it('sends only stateful chapter URLs and history, per matched source', async () => {
    const fetchKeys = vi.fn(async (_id: string, urls: { manga: string[]; chapters: string[] }) => ({
      supported: true,
      manga: urls.manga.map((url) => url.split('/')[2]),
      chapters: urls.chapters.map((url) => url.split('/')[3]),
    }));
    const keys = await resolveMihonKeys(backup, sources, fetchKeys);
    expect(fetchKeys).toHaveBeenCalledTimes(1);
    expect(fetchKeys.mock.calls[0][0]).toBe('madarasite');
    expect(fetchKeys.mock.calls[0][1].chapters).toEqual([
      '/manga/one-piece/chapter-1/',
      '/manga/one-piece/chapter-2/',
    ]);
    const resolved = keys.get(BIG_SOURCE.toString())!;
    expect(resolved.supported).toBe(true);
    expect(resolved.manga.get('/manga/one-piece/')).toBe('one-piece');
    expect(resolved.chapters.get('/manga/one-piece/chapter-2/')).toBe('chapter-2');
  });

  it('falls back when the server cannot convert URLs', async () => {
    const keys = await resolveMihonKeys(backup, sources, async () => {
      throw new Error('404');
    });
    expect(keys.get(BIG_SOURCE.toString())?.supported).toBe(false);
  });
});
