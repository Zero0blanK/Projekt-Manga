import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UNSIGNED_REPOSITORY_ERROR } from '@projekt-manga/schemas';

const mocks = vi.hoisted(() => ({ installExtension: vi.fn() }));

vi.mock('@projekt-manga/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@projekt-manga/api-client')>()),
  installExtension: mocks.installExtension,
}));
vi.mock('@/lib/query-client', () => ({
  queryClient: { invalidateQueries: vi.fn() },
  queryKeys: {},
  invalidateSourceDependentQueries: vi.fn(),
}));
vi.mock('@/lib/startup-static-data', () => ({
  clearStaticDataCache: vi.fn(),
  staticDataQueries: {},
}));

import { ApiError } from '@projekt-manga/api-client';
import { extensionActions } from '@/lib/extensions-store';

const unsigned = () =>
  new ApiError(`${UNSIGNED_REPOSITORY_ERROR}: nothing verifies this.`, 409, 'http');

beforeEach(() => mocks.installExtension.mockReset());

describe('installing from an unsigned repository', () => {
  it('retries with the acknowledgement once the user confirms', async () => {
    mocks.installExtension.mockRejectedValueOnce(unsigned()).mockResolvedValueOnce({});
    await extensionActions.install('repo', 'src', async () => true);
    expect(mocks.installExtension).toHaveBeenLastCalledWith({
      repository_id: 'repo',
      source_key: 'src',
      acknowledge_unsigned: true,
    });
  });

  it('surfaces the error and does not retry when the user declines', async () => {
    mocks.installExtension.mockRejectedValueOnce(unsigned());
    await expect(extensionActions.install('repo', 'src2', async () => false)).rejects.toThrow(
      UNSIGNED_REPOSITORY_ERROR,
    );
    expect(mocks.installExtension).toHaveBeenCalledTimes(1);
  });
});
