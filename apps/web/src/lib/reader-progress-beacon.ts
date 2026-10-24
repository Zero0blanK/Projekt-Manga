/**
 * Queues the two independent writes a reader exit needs. `sendBeacon()` can decline a
 * payload when its queue is full, so callers must fall back only for the write that was
 * not accepted instead of treating a supported Beacon API as a successful delivery.
 */
export function queueReaderProgressBeacons(
  progressUrl: string,
  progressBody: unknown,
  historyUrl: string,
  historyBody: unknown,
): { progressQueued: boolean; historyQueued: boolean } | null {
  if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') {
    return null;
  }

  let progressQueued = false;
  let historyQueued = false;
  try {
    const json = (value: unknown) =>
      new Blob([JSON.stringify(value)], { type: 'application/json' });
    progressQueued = navigator.sendBeacon(progressUrl, json(progressBody));
    historyQueued = navigator.sendBeacon(historyUrl, json(historyBody));
  } catch {
    // Keep a successful first enqueue intact, and let the caller fetch only the rest.
  }
  return { progressQueued, historyQueued };
}
