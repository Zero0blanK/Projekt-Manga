import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const wipeSelectedData = vi.fn();
const getWipeInventory = vi.fn();
const refresh = vi.fn();
const setQueryData = vi.fn();
const invalidateQueries = vi.fn();
const clearStaticDataCache = vi.fn();
const clearAllBrowseSnapshots = vi.fn();
const toast = vi.fn();
vi.mock('@/lib/wipe-data', () => ({ wipeSelectedData, getWipeInventory }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
vi.mock('@/lib/startup-static-data', () => ({ clearStaticDataCache }));
vi.mock('@/lib/browse-state', () => ({ clearAllBrowseSnapshots }));
vi.mock('@/lib/query-client', () => ({
  queryClient: { invalidateQueries, setQueryData },
  queryKeys: { mangaLibrary: ['manga-library'], libraryState: ['library-state'] },
}));
vi.mock('@/hooks/use-toast', () => ({ toast }));

const { WipeDataDialog } = await import('@/components/settings/wipe-data-dialog');

beforeEach(() => {
  vi.clearAllMocks();
  getWipeInventory.mockResolvedValue({ library: 3, history: 2, downloads: 0 });
});

describe('wipe checklist', () => {
  it('requires a selection and typed confirmation before deleting', async () => {
    const user = userEvent.setup();
    render(<WipeDataDialog />);
    const trigger = screen.getByRole('button', { name: 'Choose data to wipe…' });
    await user.click(trigger);
    const confirm = screen.getByRole('button', { name: 'Wipe selected data' });
    expect(confirm).toBeDisabled();
    expect(screen.queryByRole('checkbox', { name: /Preferences/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: /Library membership/ }));
    expect(confirm).toBeDisabled();
    await user.type(screen.getByRole('textbox'), 'WIPE');
    expect(confirm).toBeEnabled();
    expect(wipeSelectedData).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(wipeSelectedData).not.toHaveBeenCalled();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('passes only the checked items after confirmation', async () => {
    wipeSelectedData.mockResolvedValueOnce({
      library: { removed: 0, skipped: 0, failed: 0, readFailed: false },
      history: { removed: 2, skipped: 0, failed: 0, readFailed: false },
      downloads: { removed: 0, skipped: 0, failed: 0, readFailed: false },
    });
    const user = userEvent.setup();
    render(<WipeDataDialog />);
    await user.click(screen.getByRole('button', { name: 'Choose data to wipe…' }));
    await user.click(screen.getByRole('checkbox', { name: /Reading history/ }));
    await user.type(screen.getByRole('textbox'), 'WIPE');
    await user.click(screen.getByRole('button', { name: 'Wipe selected data' }));
    await waitFor(() =>
      expect(wipeSelectedData).toHaveBeenCalledWith({
        library: false,
        history: true,
        downloads: false,
      }),
    );
    await waitFor(() => expect(screen.queryByText('Choose what to wipe')).not.toBeInTheDocument());
    expect(screen.queryByText('Wipe results')).not.toBeInTheDocument();
    expect(toast).toHaveBeenCalledWith({ description: 'Wipe finished.' });
  });

  it('locks individual choices when wipe all is selected', async () => {
    const user = userEvent.setup();
    render(<WipeDataDialog />);
    await user.click(screen.getByRole('button', { name: 'Choose data to wipe…' }));
    await user.click(screen.getByRole('checkbox', { name: /Wipe all listed data/ }));
    expect(screen.getByRole('checkbox', { name: /Reading history/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Reading history/ })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(wipeSelectedData).not.toHaveBeenCalled();
  });

  it('submits every listed category for wipe all', async () => {
    wipeSelectedData.mockResolvedValueOnce({
      library: { removed: 0, skipped: 0, failed: 0, readFailed: false },
      history: { removed: 0, skipped: 0, failed: 0, readFailed: false },
      downloads: { removed: 0, skipped: 0, failed: 0, readFailed: false },
    });
    const user = userEvent.setup();
    render(<WipeDataDialog />);
    await user.click(screen.getByRole('button', { name: 'Choose data to wipe…' }));
    await user.click(screen.getByRole('checkbox', { name: /Wipe all listed data/ }));
    await user.type(screen.getByRole('textbox'), 'WIPE');
    await user.click(screen.getByRole('button', { name: 'Wipe selected data' }));
    await waitFor(() =>
      expect(wipeSelectedData).toHaveBeenCalledWith({
        library: true,
        history: true,
        downloads: true,
      }),
    );
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(clearStaticDataCache).toHaveBeenCalledOnce();
    expect(clearAllBrowseSnapshots).toHaveBeenCalledOnce();
    expect(setQueryData).toHaveBeenCalledWith(['manga-library'], []);
    expect(invalidateQueries).toHaveBeenCalledOnce();
  });

  it('closes with a neutral completion toast when an item reports failure', async () => {
    wipeSelectedData.mockResolvedValueOnce({
      library: { removed: 1, skipped: 0, failed: 1, readFailed: false },
      history: { removed: 0, skipped: 0, failed: 0, readFailed: false },
      downloads: { removed: 0, skipped: 0, failed: 0, readFailed: false },
    });
    getWipeInventory.mockResolvedValueOnce({ library: 2, history: 0, downloads: 0 });
    const user = userEvent.setup();
    render(<WipeDataDialog />);
    await user.click(screen.getByRole('button', { name: /Choose data to wipe/ }));
    await user.click(screen.getByRole('checkbox', { name: /Library membership/ }));
    await user.type(screen.getByRole('textbox'), 'WIPE');
    await user.click(screen.getByRole('button', { name: 'Wipe selected data' }));

    await waitFor(() => expect(screen.queryByText('Choose what to wipe')).not.toBeInTheDocument());
    expect(toast).toHaveBeenCalledWith({ description: 'Wipe request finished.' });
    expect(screen.queryByText('Wipe results')).not.toBeInTheDocument();
  });

  it('closes wipe all even when an item reports failure', async () => {
    wipeSelectedData.mockResolvedValueOnce({
      library: { removed: 1, skipped: 0, failed: 1, readFailed: false },
      history: { removed: 1, skipped: 0, failed: 0, readFailed: false },
      downloads: { removed: 1, skipped: 0, failed: 0, readFailed: false },
    });
    getWipeInventory.mockResolvedValueOnce({ library: 2, history: 1, downloads: 1 });
    const user = userEvent.setup();
    render(<WipeDataDialog />);
    await user.click(screen.getByRole('button', { name: /Choose data to wipe/ }));
    await user.click(screen.getByRole('checkbox', { name: /Wipe all listed data/ }));
    await user.type(screen.getByRole('textbox'), 'WIPE');
    await user.click(screen.getByRole('button', { name: 'Wipe selected data' }));

    await waitFor(() => expect(screen.queryByText('Choose what to wipe')).not.toBeInTheDocument());
    expect(toast).toHaveBeenCalledWith({ description: 'Wipe request finished.' });
  });

  it('closes and shows a completion toast when reading history cannot be verified', async () => {
    wipeSelectedData.mockResolvedValueOnce({
      library: { removed: 0, skipped: 0, failed: 0, readFailed: false },
      history: { removed: 0, skipped: 0, failed: 0, readFailed: true },
      downloads: { removed: 0, skipped: 0, failed: 0, readFailed: false },
    });
    getWipeInventory.mockResolvedValueOnce({ library: 0, history: null, downloads: 0 });
    const user = userEvent.setup();
    render(<WipeDataDialog />);
    await user.click(screen.getByRole('button', { name: /Choose data to wipe/ }));
    await user.click(screen.getByRole('checkbox', { name: /Reading history/ }));
    await user.type(screen.getByRole('textbox'), 'WIPE');
    await user.click(screen.getByRole('button', { name: 'Wipe selected data' }));

    await waitFor(() => expect(screen.queryByText('Choose what to wipe')).not.toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(toast).toHaveBeenCalledWith({ description: 'Wipe request finished.' });
  });

  it('closes and shows a completion toast even when individual items fail', async () => {
    wipeSelectedData.mockResolvedValueOnce({
      library: { removed: 1, skipped: 0, failed: 1, readFailed: false },
      history: { removed: 0, skipped: 0, failed: 0, readFailed: false },
      downloads: { removed: 0, skipped: 0, failed: 0, readFailed: false },
    });
    getWipeInventory.mockResolvedValueOnce({ library: 2, history: 0, downloads: 0 });
    const user = userEvent.setup();
    render(<WipeDataDialog />);
    await user.click(screen.getByRole('button', { name: /Choose data to wipe/ }));
    await user.click(screen.getByRole('checkbox', { name: /Library membership/ }));
    await user.type(screen.getByRole('textbox'), 'WIPE');
    await user.click(screen.getByRole('button', { name: 'Wipe selected data' }));

    await waitFor(() => expect(screen.queryByText('Choose what to wipe')).not.toBeInTheDocument());
    expect(toast).toHaveBeenCalledWith({ description: 'Wipe request finished.' });
  });

  it('closes immediately after confirmation while the wipe runs', async () => {
    let finish!: (value: unknown) => void;
    wipeSelectedData.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const user = userEvent.setup();
    render(<WipeDataDialog />);
    await user.click(screen.getByRole('button', { name: /Choose data to wipe/ }));
    await user.click(screen.getByRole('checkbox', { name: /Reading history/ }));
    await user.type(screen.getByRole('textbox'), 'WIPE');
    await user.click(screen.getByRole('button', { name: 'Wipe selected data' }));

    expect(screen.queryByText('Choose what to wipe')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Wiping…' })).toBeDisabled();
    finish({
      library: { removed: 0, skipped: 0, failed: 0, readFailed: false },
      history: { removed: 0, skipped: 0, failed: 0, readFailed: false },
      downloads: { removed: 0, skipped: 0, failed: 0, readFailed: false },
    });
    await waitFor(() => expect(toast).toHaveBeenCalledWith({ description: 'Wipe finished.' }));
  });

  it('keeps the dialog closed and reports an unexpected wipe error in a toast', async () => {
    wipeSelectedData.mockRejectedValueOnce(new Error('network failure'));
    const user = userEvent.setup();
    render(<WipeDataDialog />);
    await user.click(screen.getByRole('button', { name: /Choose data to wipe/ }));
    await user.click(screen.getByRole('checkbox', { name: /Reading history/ }));
    await user.type(screen.getByRole('textbox'), 'WIPE');
    await user.click(screen.getByRole('button', { name: 'Wipe selected data' }));

    expect(screen.queryByText('Choose what to wipe')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith({
        description: 'Wipe could not finish. Some data may have been removed.',
      }),
    );
    expect(invalidateQueries).toHaveBeenCalledOnce();
  });
});
