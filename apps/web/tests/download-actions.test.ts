import { afterEach, describe, expect, it, vi } from 'vitest';

const { cancelDownload, toast } = vi.hoisted(() => ({ cancelDownload: vi.fn(), toast: vi.fn() }));
vi.mock('@projekt-manga/api-client', () => ({
  cancelDownload: (...args: unknown[]) => cancelDownload(...args),
}));
vi.mock('@/hooks/use-toast', () => ({ toast: (...args: unknown[]) => toast(...args) }));

const { removeFailedDownloads } = await import('@/components/downloads/actions');

const row = (id: string) => ({ id, title: id, status: 'failed' }) as never;

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('removeFailedDownloads', () => {
  it('confirms, continues through partial failures, and refreshes after the batch', async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    cancelDownload.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('offline'));
    const onDone = vi.fn();

    await removeFailedDownloads([row('one'), row('two')], confirm, onDone);

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ description: expect.stringContaining('2 failed downloads') }),
    );
    expect(cancelDownload.mock.calls).toEqual([['one'], ['two']]);
    expect(onDone).toHaveBeenCalledOnce();
    expect(toast).toHaveBeenCalledWith({
      description: 'Removed 1 of 2 failed downloads. Refresh and retry the rest.',
    });
  });

  it('does not remove records if the user declines confirmation', async () => {
    await removeFailedDownloads([row('one')], vi.fn().mockResolvedValue(false));
    expect(cancelDownload).not.toHaveBeenCalled();
  });
});
