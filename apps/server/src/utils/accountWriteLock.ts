/** Serializes account-wide restore and sync writes within this API process. A sync that
 * began before a restore was queued must finish first; one that starts afterwards sees
 * the active job and cannot replay old progress over the restored snapshot. */
const tails = new Map<string, Promise<void>>();

export async function withAccountWriteLock<T>(owner: string, work: () => Promise<T>): Promise<T> {
  const previous = tails.get(owner) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  tails.set(owner, tail);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (tails.get(owner) === tail) tails.delete(owner);
  }
}
