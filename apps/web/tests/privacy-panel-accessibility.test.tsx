import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
vi.mock('@/components/discover/content-privacy', () => ({ ContentPrivacyControls: () => null }));

const {
  currentUser,
  resetAll,
  deleteAccount,
  getHistory,
  getPendingRestore,
  parseBackup,
  previewRestore,
  safeParse,
  startReplaceRestore,
  savePendingRestore,
  toast,
} = vi.hoisted(() => ({
  currentUser: { user: null as { id: string; email: string } | null, loading: false },
  resetAll: vi.fn(),
  deleteAccount: vi.fn(),
  getHistory: vi.fn(),
  getPendingRestore: vi.fn(),
  parseBackup: vi.fn(),
  previewRestore: vi.fn(),
  safeParse: vi.fn(),
  startReplaceRestore: vi.fn(),
  savePendingRestore: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('@projekt-manga/api-client', () => ({
  getAllDownloads: vi.fn(),
  getHistory,
  getLibraryState: vi.fn(),
  getManga: vi.fn(),
  getMangaDetailsById: vi.fn(),
  previewRestore,
  startReplaceRestore,
  ApiError: class ApiError extends Error {},
}));
vi.mock('@projekt-manga/schemas', () => ({
  replaceBackupBodySchema: { safeParse },
  RESTORE_UPLOAD_LIMIT_BYTES: 10 * 1024 * 1024,
}));
vi.mock('@/lib/restore-job', () => ({
  savePendingRestore,
  clearPendingRestore: vi.fn(),
  getPendingRestore,
}));
vi.mock('@/lib/backup-validation', () => ({
  parseBackup,
  previewBackupMerge: vi.fn(),
}));
vi.mock('@/components/settings/field-controls', () => ({
  Panel: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
  Field: ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div>
      <span>{label}</span>
      {children}
    </div>
  ),
  Group: ({ label }: { label: string }) => <h3>{label}</h3>,
  ActionButton: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
}));
vi.mock('@/lib/app-store', () => ({
  actions: { resetAll },
  setState: vi.fn(),
}));
vi.mock('@/lib/theme', () => ({ APP_STATE_STORAGE_KEY: 'fixture-settings' }));
vi.mock('@/lib/session-resource', () => ({
  useCurrentUser: () => currentUser,
  sessionActions: { deleteAccount },
}));
vi.mock('@/components/settings/wipe-data-dialog', () => ({
  WipeDataDialog: () => <button>Choose data to wipe…</button>,
}));
vi.mock('@/lib/library-store', () => ({ useMangaLibrary: () => ({ manga: [], loading: false }) }));
vi.mock('@/hooks/use-toast', () => ({ toast }));

const { PrivacyPanel } = await import('@/components/settings/privacy-panel');

describe('PrivacyPanel accessibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentUser.user = null;
    currentUser.loading = false;
    getPendingRestore.mockReturnValue(null);
    getHistory.mockResolvedValue([]);
    previewRestore.mockResolvedValue({
      matchingTitles: 0,
      addedTitles: 0,
      importedTitles: 0,
      catalogRowsUpdated: 0,
      catalogUpdateExamples: [],
      chapterIdentityConflicts: 0,
      chapterIdentityConflictExamples: [],
      retainedHistory: 0,
      addedHistory: 0,
    });
  });

  it('rejects an oversized serialized request before saving a pending job or submitting', async () => {
    parseBackup.mockReturnValue({ version: 2, manga: [], library: [], history: [], downloads: [] });
    safeParse.mockReturnValue({
      success: true,
      data: { description: 'x'.repeat(10 * 1024 * 1024) },
    });
    const user = userEvent.setup();
    render(<PrivacyPanel />);
    const file = new File(['{}'], 'backup.json', { type: 'application/json' });
    Object.defineProperty(file, 'text', { value: async () => '{}' });
    fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [file] } });
    const merge = await screen.findByRole('button', { name: 'Merge backup' });
    await waitFor(() => expect(merge).toBeEnabled());
    await user.click(merge);
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith({
        description: 'The restore request exceeds the 10 MiB limit. No data was changed.',
      }),
    );
    expect(savePendingRestore).not.toHaveBeenCalled();
    expect(startReplaceRestore).not.toHaveBeenCalled();
  });

  it('returns focus to Reset preferences when its confirmation is cancelled', async () => {
    const user = userEvent.setup();
    render(<PrivacyPanel />);

    const trigger = screen.getByRole('button', { name: 'Reset preferences' });
    await user.click(trigger);
    expect(
      await screen.findByRole('alertdialog', { name: 'Reset all preferences?' }),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(trigger).toHaveFocus());
    expect(resetAll).not.toHaveBeenCalled();
  });

  it('returns focus to Delete account when account deletion is cancelled', async () => {
    currentUser.user = { id: 'reader-1', email: 'reader@example.test' };
    const user = userEvent.setup();
    render(<PrivacyPanel />);

    const trigger = screen.getByRole('button', { name: 'Delete account' });
    await user.click(trigger);
    expect(await screen.findByRole('alertdialog', { name: 'Delete your account?' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(trigger).toHaveFocus());
    expect(deleteAccount).not.toHaveBeenCalled();
  });

  it('returns focus to Choose export after cancelling the restore preview', async () => {
    parseBackup.mockReturnValue({ version: 2, manga: [], library: [], history: [], downloads: [] });
    const user = userEvent.setup();
    render(<PrivacyPanel />);

    const trigger = screen.getByRole('button', { name: 'Choose export' });
    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).not.toBeNull();
    const file = new File(['{}'], 'backup.json', { type: 'application/json' });
    Object.defineProperty(file, 'text', { value: async () => '{}' });
    fireEvent.change(fileInput!, { target: { files: [file] } });

    expect(await screen.findByRole('alertdialog', { name: 'Restore this backup?' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
