import { beforeEach, describe, expect, it, vi } from 'vitest';
import { extensionActions } from '@/lib/extensions-store';
const mocks = vi.hoisted(() => ({ install: vi.fn(), invalidate: vi.fn(), clear: vi.fn() }));
vi.mock('@projekt-manga/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@projekt-manga/api-client')>()),
  installExtension: mocks.install,
}));
vi.mock('@/lib/query-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/query-client')>()),
  invalidateSourceDependentQueries: mocks.invalidate,
}));
vi.mock('@/lib/startup-static-data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/startup-static-data')>()),
  clearStaticDataCache: mocks.clear,
}));
beforeEach(() => {
  vi.clearAllMocks();
});
describe('language extension installation coordination', () => {
  it('shares concurrent requests and refreshes the source lists once', async () => {
    let finish!: () => void;
    mocks.install.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const first = extensionActions.install('repo', 'mangadex-ja');
    const second = extensionActions.install('repo', 'mangadex-ja');
    expect(mocks.install).toHaveBeenCalledTimes(1);
    finish();
    await Promise.all([first, second]);
    expect(mocks.clear).toHaveBeenCalledTimes(1);
    expect(mocks.invalidate).toHaveBeenCalledTimes(1);
  });
  it('releases failed requests so installation can be retried', async () => {
    mocks.install.mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce(undefined);
    await expect(extensionActions.install('repo', 'mangadex-ja')).rejects.toThrow('Offline');
    await expect(extensionActions.install('repo', 'mangadex-ja')).resolves.toBeUndefined();
    expect(mocks.install).toHaveBeenCalledTimes(2);
    expect(mocks.invalidate).toHaveBeenCalledTimes(1);
  });
});
