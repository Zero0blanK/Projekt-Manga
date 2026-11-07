/** Enough for several tabs plus the desktop app behind one address. */
const DEFAULT_LIMIT_PER_CLIENT = 10;

/**
 * Open event streams per client address.
 *
 * The global caps on streams exist to bound memory, but with nothing per client a single
 * caller could hold every slot and lock everyone else out of live updates.
 */
export class StreamLimiter {
  private readonly open = new Map<string, number>();

  constructor(private readonly limit = DEFAULT_LIMIT_PER_CLIENT) {}

  acquire(client: string | undefined): boolean {
    const key = client ?? 'unknown';
    const count = this.open.get(key) ?? 0;
    if (count >= this.limit) return false;
    this.open.set(key, count + 1);
    return true;
  }

  release(client: string | undefined): void {
    const key = client ?? 'unknown';
    const count = (this.open.get(key) ?? 0) - 1;
    if (count > 0) this.open.set(key, count);
    else this.open.delete(key);
  }
}
