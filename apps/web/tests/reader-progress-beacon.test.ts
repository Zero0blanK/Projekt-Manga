import { afterEach, describe, expect, it, vi } from 'vitest';
import { queueReaderProgressBeacons } from '@/lib/reader-progress-beacon';

const originalSendBeacon = navigator.sendBeacon;

afterEach(() => {
  Object.defineProperty(navigator, 'sendBeacon', {
    configurable: true,
    value: originalSendBeacon,
  });
});

describe('queueReaderProgressBeacons', () => {
  it('records which write was actually accepted by the browser queue', () => {
    const sendBeacon = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
    Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: sendBeacon });

    expect(queueReaderProgressBeacons('/progress', { page: 4 }, '/history', { page: 4 })).toEqual({
      progressQueued: true,
      historyQueued: false,
    });
    expect(sendBeacon).toHaveBeenCalledTimes(2);
  });

  it('preserves a successful first enqueue when the second call throws', () => {
    const sendBeacon = vi
      .fn()
      .mockReturnValueOnce(true)
      .mockImplementationOnce(() => {
        throw new Error('beacon queue unavailable');
      });
    Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: sendBeacon });

    expect(queueReaderProgressBeacons('/progress', {}, '/history', {})).toEqual({
      progressQueued: true,
      historyQueued: false,
    });
  });
});
