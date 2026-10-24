import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  cancelDownload: vi.fn(),
  deleteHistory: vi.fn(),
  getAllDownloads: vi.fn(),
  getHistory: vi.fn(),
  getManga: vi.fn(),
  getServerHistory: vi.fn(),
  getServerManga: vi.fn(),
  hasLocalDataBridge: vi.fn(),
  localInvoke: vi.fn(),
  setMangaInLibrary: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(
      public message: string,
      public status: number,
    ) {
      super(message);
    }
  },
}));
vi.mock('@projekt-manga/api-client', () => api);

const { getWipeInventory, wipeSelectedData } = await import('@/lib/wipe-data');

beforeEach(() => {
  vi.clearAllMocks();
  api.hasLocalDataBridge.mockReturnValue(false);
  api.getServerManga.mockResolvedValue([]);
  api.getManga.mockResolvedValue([]);
  api.getServerHistory.mockResolvedValue([]);
  api.getHistory.mockResolvedValue([]);
  api.getAllDownloads.mockResolvedValue([]);
});

describe('wipeSelectedData', () => {
  it('counts distinct desktop and server entries and distinguishes failed reads from zero', async () => {
    api.hasLocalDataBridge.mockReturnValue(true);
    api.getServerManga.mockResolvedValue([{ id: 'one' }]);
    api.getManga.mockResolvedValue([{ id: 'one' }, { id: 'two' }]);
    api.getServerHistory.mockRejectedValue(new Error('offline'));
    const result = await getWipeInventory();
    expect(result).toEqual({ library: 2, history: null, downloads: 0 });
  });
  it('only deletes selected categories after loading the targets', async () => {
    api.getServerManga.mockResolvedValue([{ id: 'm-1' }]);
    api.getServerHistory.mockResolvedValue([{ id: 'h-1' }]);
    api.getAllDownloads.mockResolvedValue([{ id: 'd-1' }]);
    await wipeSelectedData({ library: true, history: false, downloads: true });
    expect(api.cancelDownload).toHaveBeenCalledWith('d-1');
    expect(api.setMangaInLibrary).toHaveBeenCalledWith('m-1', false);
    expect(api.getServerHistory).not.toHaveBeenCalled();
    expect(api.deleteHistory).not.toHaveBeenCalled();
  });

  it('continues other categories when one inventory cannot be read', async () => {
    api.getServerHistory.mockRejectedValue(new Error('offline'));
    const result = await wipeSelectedData({
      library: false,
      history: true,
      downloads: false,
    });
    expect(result.history.readFailed).toBe(true);
    expect(api.deleteHistory).not.toHaveBeenCalled();
  });

  it('skips missing rows and keeps wiping after a failed item', async () => {
    api.getServerManga.mockResolvedValue([{ id: 'gone' }, { id: 'broken' }, { id: 'ok' }]);
    api.setMangaInLibrary
      .mockRejectedValueOnce(new api.ApiError('missing', 404))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({});
    const result = await wipeSelectedData({
      library: true,
      history: false,
      downloads: false,
    });
    expect(result.library).toEqual({ removed: 1, skipped: 1, failed: 1, readFailed: false });
    expect(api.setMangaInLibrary).toHaveBeenCalledTimes(3);
  });

  it('clears desktop-only library and history rows without deleting unrelated server rows', async () => {
    api.hasLocalDataBridge.mockReturnValue(true);
    api.getServerManga.mockResolvedValue([{ id: 'shared-manga' }]);
    api.getManga.mockResolvedValue([{ id: 'shared-manga' }, { id: 'offline-manga' }]);
    api.getServerHistory.mockResolvedValue([{ id: 'server-history' }]);
    api.getHistory.mockResolvedValue([{ id: 'server-history' }, { id: 'offline-history' }]);
    await wipeSelectedData({ library: true, history: true, downloads: false });
    expect(api.setMangaInLibrary).toHaveBeenCalledWith('shared-manga', false);
    expect(api.deleteHistory).toHaveBeenCalledWith('server-history');
    expect(api.localInvoke).toHaveBeenCalledWith('manga', 'setInLibrary', {
      mangaId: 'offline-manga',
      inLibrary: false,
    });
    expect(api.localInvoke).toHaveBeenCalledWith('history', 'delete', { id: 'offline-history' });
  });

  it('clears desktop copies even when the corresponding server rows are already gone', async () => {
    api.hasLocalDataBridge.mockReturnValue(true);
    api.getServerManga.mockResolvedValue([{ id: 'm-1' }]);
    api.getManga.mockResolvedValue([{ id: 'm-1' }]);
    api.getServerHistory.mockResolvedValue([{ id: 'h-1' }]);
    api.getHistory.mockResolvedValue([{ id: 'h-1' }]);
    api.setMangaInLibrary.mockRejectedValue(new api.ApiError('missing', 404));
    api.deleteHistory.mockRejectedValue(new api.ApiError('missing', 404));
    const result = await wipeSelectedData({
      library: true,
      history: true,
      downloads: false,
    });
    expect(api.localInvoke).toHaveBeenCalledWith('manga', 'setInLibrary', {
      mangaId: 'm-1',
      inLibrary: false,
    });
    expect(api.localInvoke).toHaveBeenCalledWith('history', 'delete', { id: 'h-1' });
    expect(result.library.skipped).toBe(1);
    expect(result.history.skipped).toBe(1);
  });
});
