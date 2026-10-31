/** A damaged or unsupported backup. The message is safe to show as is. */
export class MihonBackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MihonBackupError';
  }
}

const truncated = () => new MihonBackupError('The backup file is truncated or damaged.');

export const WIRE_VARINT = 0;
export const WIRE_FIXED64 = 1;
export const WIRE_BYTES = 2;
export const WIRE_FIXED32 = 5;

const utf8 = new TextDecoder('utf-8');

/**
 * Just enough of the protobuf wire format to walk a Mihon backup: varints, 32/64-bit fixed
 * values and length-delimited fields. Fields a caller does not ask for are skipped by wire
 * type, so newer backups with extra fields still read. Every read is bounds-checked and
 * throws `MihonBackupError` on a short buffer.
 */
export class ProtoReader {
  private pos: number;
  private readonly view: DataView;

  constructor(
    private readonly bytes: Uint8Array,
    start = 0,
    private readonly end = bytes.length,
  ) {
    this.pos = start;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get done(): boolean {
    return this.pos >= this.end;
  }

  /** The next field's number and wire type. */
  tag(): { field: number; wire: number } {
    const value = this.varint();
    const field = Number(value >> 3n);
    if (field < 1) throw new MihonBackupError('The backup file is not a Mihon backup.');
    return { field, wire: Number(value & 7n) };
  }

  /** An unsigned varint of up to 64 bits. */
  varint(): bigint {
    let low = 0;
    let shift = 0;
    // Fast path: the first four bytes fit in a plain number.
    while (shift < 28) {
      if (this.pos >= this.end) throw truncated();
      const byte = this.bytes[this.pos++];
      low |= (byte & 0x7f) << shift;
      if (byte < 0x80) return BigInt(low >>> 0);
      shift += 7;
    }
    let result = BigInt(low >>> 0);
    let big = 28n;
    for (let index = 4; index < 10; index++) {
      if (this.pos >= this.end) throw truncated();
      const byte = this.bytes[this.pos++];
      result |= BigInt(byte & 0x7f) << big;
      if (byte < 0x80) return BigInt.asUintN(64, result);
      big += 7n;
    }
    throw new MihonBackupError('The backup file is damaged (bad number).');
  }

  int32(): number {
    return Number(BigInt.asIntN(32, this.varint()));
  }

  /** A signed 64-bit value. Kept as a bigint: Mihon's source ids use all 63 bits. */
  int64(): bigint {
    return BigInt.asIntN(64, this.varint());
  }

  /** A 64-bit value that is only ever a timestamp or count, so a number is exact enough. */
  long(): number {
    return Number(this.int64());
  }

  bool(): boolean {
    return this.varint() !== 0n;
  }

  float(): number {
    if (this.pos + 4 > this.end) throw truncated();
    const value = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return value;
  }

  /** The bounds of a length-delimited field, after which the reader sits past it. */
  private span(): [number, number] {
    const length = this.varint();
    if (length > BigInt(this.end - this.pos)) throw truncated();
    const start = this.pos;
    this.pos += Number(length);
    return [start, this.pos];
  }

  string(): string {
    const [start, end] = this.span();
    return utf8.decode(this.bytes.subarray(start, end));
  }

  /** A reader over an embedded message. */
  message(): ProtoReader {
    const [start, end] = this.span();
    return new ProtoReader(this.bytes, start, end);
  }

  /** A repeated scalar field: packed (one length-delimited run) or one value per tag. */
  repeated<T>(wire: number, read: (reader: ProtoReader) => T): T[] {
    if (wire !== WIRE_BYTES) return [read(this)];
    const inner = this.message();
    const values: T[] = [];
    while (!inner.done) values.push(read(inner));
    return values;
  }

  skip(wire: number): void {
    switch (wire) {
      case WIRE_VARINT:
        this.varint();
        return;
      case WIRE_FIXED64:
        if (this.pos + 8 > this.end) throw truncated();
        this.pos += 8;
        return;
      case WIRE_BYTES:
        this.span();
        return;
      case WIRE_FIXED32:
        if (this.pos + 4 > this.end) throw truncated();
        this.pos += 4;
        return;
      default:
        // Groups (3/4) were never used by Mihon; anything else means this is not protobuf.
        throw new MihonBackupError('The backup file is not a Mihon backup.');
    }
  }
}
