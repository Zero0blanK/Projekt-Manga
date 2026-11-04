import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  getHealth: vi.fn(),
  checkForUpdate: vi.fn(),
  uninstall: vi.fn(),
}));

vi.mock('@/hooks/use-toast', () => ({ toast: mocks.toast }));
vi.mock('@projekt-manga/api-client', () => ({ getHealth: mocks.getHealth }));
vi.mock('@/hooks/use-confirm', () => ({
  useConfirm: () => ({ confirm: async () => true, dialog: null }),
}));
vi.mock('@/lib/extensions-store', () => ({
  extensionActions: { checkForUpdate: mocks.checkForUpdate, uninstall: mocks.uninstall },
}));

const { toastWithUndo } = await import('@/lib/undo-toast');
const { ConnectionBanner } = await import('@/components/connection-banner');
const { SourceBulkBar } = await import('@/components/discover/source-bulk-bar');
const { queryClient } = await import('@/lib/query-client');

beforeEach(() => {
  vi.clearAllMocks();
  queryClient.clear();
  mocks.getHealth.mockResolvedValue({ status: 'ok' });
});
afterEach(cleanup);

describe('toastWithUndo', () => {
  it('offers an undo that runs the way back', () => {
    const undo = vi.fn().mockResolvedValue(undefined);
    toastWithUndo('Removed One Piece', undo);
    const { description, action } = mocks.toast.mock.calls[0][0];
    expect(description).toBe('Removed One Piece');
    action.props.onClick();
    expect(undo).toHaveBeenCalledOnce();
  });

  it('says so when the undo fails', async () => {
    toastWithUndo('Removed', () => Promise.reject(new Error('down')));
    mocks.toast.mock.calls[0][0].action.props.onClick();
    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith({ description: "Couldn't undo that. Try again." }),
    );
  });
});

describe('ConnectionBanner', () => {
  it('stays out of the way while everything answers', async () => {
    render(<ConnectionBanner />);
    await waitFor(() => expect(mocks.getHealth).toHaveBeenCalled());
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('says when the server stops answering', async () => {
    mocks.getHealth.mockRejectedValue(new Error('down'));
    render(<ConnectionBanner />);
    await screen.findByText(/reach the library server/, undefined, { timeout: 4000 });
  });

  it('says what still works when the device goes offline', async () => {
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    render(<ConnectionBanner />);
    act(() => void window.dispatchEvent(new Event('offline')));
    expect(await screen.findByRole('link', { name: 'downloaded chapters' })).toHaveAttribute(
      'href',
      '/downloads',
    );
    onLine.mockRestore();
  });
});

describe('SourceBulkBar', () => {
  const records = [{ id: 'a' }, { id: 'b' }] as never[];

  it('updates every selected install and reports how many changed', async () => {
    const user = userEvent.setup();
    mocks.checkForUpdate.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    render(<SourceBulkBar ids={['a', 'b']} records={records} onPin={vi.fn()} onClose={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith({ description: '1 source updated.' }),
    );
  });

  it('removes after confirming, and keeps going past a failure', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    mocks.uninstall.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('no'));
    render(<SourceBulkBar ids={['a', 'b']} records={records} onPin={vi.fn()} onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(mocks.uninstall).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith({ description: "1 source couldn't be removed." }),
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it('only pins when nothing selected is an install', () => {
    render(<SourceBulkBar ids={['suwayomi:1']} records={[]} onPin={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Pin' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeDisabled();
  });
});
