type Job = { start: () => void; signal: AbortSignal; reject: (reason: unknown) => void };
const queue: Job[] = [];
let active = 0;
function drain() {
  while (active < 3 && queue.length) {
    const job = queue.shift()!;
    if (job.signal.aborted) {
      job.reject(new DOMException('Search cancelled', 'AbortError'));
      continue;
    }
    active += 1;
    job.start();
  }
}
/** Shared by initial searches, retries, and pagination so all requests obey the same cap. */
export function scheduleSourceSearch<T>(
  signal: AbortSignal,
  request: () => Promise<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      const index = queue.indexOf(job);
      if (index >= 0) {
        queue.splice(index, 1);
        reject(new DOMException('Search cancelled', 'AbortError'));
      }
    };
    const job: Job = {
      signal,
      reject,
      start: () => {
        signal.removeEventListener('abort', abort);
        Promise.resolve()
          .then(request)
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            drain();
          });
      },
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      signal.removeEventListener('abort', abort);
      reject(new DOMException('Search cancelled', 'AbortError'));
      return;
    }
    queue.push(job);
    drain();
  });
}
