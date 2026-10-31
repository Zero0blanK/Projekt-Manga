import { MihonBackupError, ProtoReader, WIRE_BYTES, WIRE_FIXED32 } from './protobuf';

/**
 * The parts of a Mihon/Tachiyomi backup (`Backup` in Mihon's
 * `data/backup/models`) this app imports. Field numbers follow Mihon's `@ProtoNumber`s;
 * everything else in the file is skipped.
 */
export interface MihonChapter {
  url: string;
  name: string;
  scanlator: string | null;
  read: boolean;
  bookmark: boolean;
  lastPageRead: number;
  chapterNumber: number;
  /** Milliseconds since the epoch; 0 when unknown. */
  dateUpload: number;
}

export interface MihonHistory {
  url: string;
  /** Milliseconds since the epoch. */
  lastRead: number;
}

export interface MihonTracking {
  /** Mihon's tracker id: 1 MAL, 2 AniList, 3 Kitsu, 4 Shikimori, 5 Bangumi, 6 Komga,
   * 7 MangaUpdates, 8 Kavita. */
  syncId: number;
  /** The tracker's id for the title, as a decimal string. */
  mediaId: string;
  trackingUrl: string;
  title: string;
}

export interface MihonManga {
  /** Mihon's numeric source id, as a decimal string (it does not fit in a number). */
  source: string;
  url: string;
  title: string;
  author: string | null;
  artist: string | null;
  description: string | null;
  genres: string[];
  /** Mihon's SManga status: 0 unknown, 1 ongoing, 2 completed, 3 licensed,
   * 4 publishing finished, 5 cancelled, 6 on hiatus. */
  status: number;
  thumbnailUrl: string | null;
  /** Milliseconds since the epoch; 0 when unknown. */
  dateAdded: number;
  /** In the library. Mihon also backs up titles that only have history. */
  favorite: boolean;
  /** The `order` of each category this title is in (Mihon links by order, not id). */
  categories: number[];
  chapters: MihonChapter[];
  history: MihonHistory[];
  tracking: MihonTracking[];
}

export interface MihonCategory {
  name: string;
  order: number;
}

export interface MihonSource {
  id: string;
  name: string;
}

export interface MihonBackup {
  manga: MihonManga[];
  categories: MihonCategory[];
  sources: MihonSource[];
}

const optional = (value: string) => (value.trim() ? value : null);

function readChapter(reader: ProtoReader): MihonChapter {
  const chapter: MihonChapter = {
    url: '',
    name: '',
    scanlator: null,
    read: false,
    bookmark: false,
    lastPageRead: 0,
    chapterNumber: 0,
    dateUpload: 0,
  };
  while (!reader.done) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === WIRE_BYTES) chapter.url = reader.string();
    else if (field === 2 && wire === WIRE_BYTES) chapter.name = reader.string();
    else if (field === 3 && wire === WIRE_BYTES) chapter.scanlator = optional(reader.string());
    else if (field === 4 && wire === 0) chapter.read = reader.bool();
    else if (field === 5 && wire === 0) chapter.bookmark = reader.bool();
    else if (field === 6 && wire === 0) chapter.lastPageRead = Math.max(0, reader.long());
    else if (field === 8 && wire === 0) chapter.dateUpload = reader.long();
    else if (field === 9 && wire === WIRE_FIXED32) chapter.chapterNumber = reader.float();
    else reader.skip(wire);
  }
  return chapter;
}

function readHistory(reader: ProtoReader): MihonHistory {
  const history: MihonHistory = { url: '', lastRead: 0 };
  while (!reader.done) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === WIRE_BYTES) history.url = reader.string();
    else if (field === 2 && wire === 0) history.lastRead = reader.long();
    else reader.skip(wire);
  }
  return history;
}

function readTracking(reader: ProtoReader): MihonTracking {
  const tracking: MihonTracking = { syncId: 0, mediaId: '', trackingUrl: '', title: '' };
  let legacyMediaId = 0;
  while (!reader.done) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === 0) tracking.syncId = reader.int32();
    else if (field === 3 && wire === 0) legacyMediaId = reader.int32();
    else if (field === 4 && wire === WIRE_BYTES) tracking.trackingUrl = reader.string();
    else if (field === 5 && wire === WIRE_BYTES) tracking.title = reader.string();
    else if (field === 100 && wire === 0) tracking.mediaId = reader.int64().toString();
    else reader.skip(wire);
  }
  // Old Tachiyomi backups only carry the 32-bit id.
  if ((!tracking.mediaId || tracking.mediaId === '0') && legacyMediaId > 0)
    tracking.mediaId = String(legacyMediaId);
  return tracking;
}

function readManga(reader: ProtoReader): MihonManga {
  const manga: MihonManga = {
    source: '0',
    url: '',
    title: '',
    author: null,
    artist: null,
    description: null,
    genres: [],
    status: 0,
    thumbnailUrl: null,
    dateAdded: 0,
    favorite: true,
    categories: [],
    chapters: [],
    history: [],
    tracking: [],
  };
  while (!reader.done) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === 0) manga.source = reader.int64().toString();
    else if (field === 2 && wire === WIRE_BYTES) manga.url = reader.string();
    else if (field === 3 && wire === WIRE_BYTES) manga.title = reader.string();
    else if (field === 4 && wire === WIRE_BYTES) manga.artist = optional(reader.string());
    else if (field === 5 && wire === WIRE_BYTES) manga.author = optional(reader.string());
    else if (field === 6 && wire === WIRE_BYTES) manga.description = optional(reader.string());
    else if (field === 7 && wire === WIRE_BYTES) manga.genres.push(reader.string());
    else if (field === 8 && wire === 0) manga.status = reader.int32();
    else if (field === 9 && wire === WIRE_BYTES) manga.thumbnailUrl = optional(reader.string());
    else if (field === 13 && wire === 0) manga.dateAdded = reader.long();
    else if (field === 16 && wire === WIRE_BYTES)
      manga.chapters.push(readChapter(reader.message()));
    else if (field === 17 && (wire === 0 || wire === WIRE_BYTES))
      manga.categories.push(...reader.repeated(wire, (inner) => inner.long()));
    else if (field === 18 && wire === WIRE_BYTES)
      manga.tracking.push(readTracking(reader.message()));
    else if (field === 100 && wire === 0) manga.favorite = reader.bool();
    // 102 is the pre-1.x "brokenHistory" list; same shape as 104.
    else if ((field === 102 || field === 104) && wire === WIRE_BYTES)
      manga.history.push(readHistory(reader.message()));
    else reader.skip(wire);
  }
  return manga;
}

function readCategory(reader: ProtoReader): MihonCategory {
  const category: MihonCategory = { name: '', order: 0 };
  while (!reader.done) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === WIRE_BYTES) category.name = reader.string();
    else if (field === 2 && wire === 0) category.order = reader.long();
    else reader.skip(wire);
  }
  return category;
}

function readSource(reader: ProtoReader): MihonSource {
  const source: MihonSource = { id: '0', name: '' };
  while (!reader.done) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === WIRE_BYTES) source.name = reader.string();
    else if (field === 2 && wire === 0) source.id = reader.int64().toString();
    else reader.skip(wire);
  }
  return source;
}

/** Decodes an uncompressed Mihon backup. Throws `MihonBackupError` on damaged input. */
export function decodeMihonBackup(bytes: Uint8Array): MihonBackup {
  const reader = new ProtoReader(bytes);
  const backup: MihonBackup = { manga: [], categories: [], sources: [] };
  while (!reader.done) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === WIRE_BYTES) backup.manga.push(readManga(reader.message()));
    else if (field === 2 && wire === WIRE_BYTES)
      backup.categories.push(readCategory(reader.message()));
    else if (field === 101 && wire === WIRE_BYTES)
      backup.sources.push(readSource(reader.message()));
    else reader.skip(wire);
  }
  if (backup.manga.length === 0 && backup.categories.length === 0 && backup.sources.length === 0)
    throw new MihonBackupError('That file has no Mihon library in it.');
  return backup;
}

/** Decompressed backups above this are refused: a real library is a few MiB. */
export const MIHON_BACKUP_MAX_BYTES = 128 * 1024 * 1024;

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(bytes as Uint8Array<ArrayBuffer>);
      controller.close();
    },
  }).pipeThrough(new DecompressionStream('gzip'));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MIHON_BACKUP_MAX_BYTES) {
        void reader.cancel();
        throw new MihonBackupError('That backup is too large to import.');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof MihonBackupError) throw error;
    throw new MihonBackupError('The backup file is truncated or damaged.');
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Reads a `.tachibk` / `.proto.gz` file. An already-decompressed backup is accepted too. */
export async function readMihonBackupFile(file: Blob): Promise<MihonBackup> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const gzipped = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  return decodeMihonBackup(gzipped ? await gunzip(bytes) : bytes);
}
