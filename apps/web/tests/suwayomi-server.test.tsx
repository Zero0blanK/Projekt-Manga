import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const getSuwayomiSettings = vi.fn();
const saveSuwayomiSettings = vi.fn();
const removeSuwayomiSettings = vi.fn();
const testSuwayomiConnection = vi.fn();
const importSuwayomiLibrary = vi.fn();
const invalidateQueries = vi.fn();

vi.mock('@projekt-manga/api-client', () => ({
  getSuwayomiSettings: (...args: unknown[]) => getSuwayomiSettings(...args),
  saveSuwayomiSettings: (...args: unknown[]) => saveSuwayomiSettings(...args),
  removeSuwayomiSettings: (...args: unknown[]) => removeSuwayomiSettings(...args),
  testSuwayomiConnection: (...args: unknown[]) => testSuwayomiConnection(...args),
  importSuwayomiLibrary: (...args: unknown[]) => importSuwayomiLibrary(...args),
}));
vi.mock('@/hooks/use-confirm', () => ({
  useConfirm: () => ({ confirm: async () => true, dialog: null }),
}));
vi.mock('@/lib/query-client', () => ({
  queryClient: { invalidateQueries: (...args: unknown[]) => invalidateQueries(...args) },
  queryKeys: { sources: ['sources'] },
}));

const { SuwayomiServer } = await import('@/components/settings/suwayomi-server');

const PASSWORD = 'hunter2-secret';
const savedWithPassword = {
  enabled: true,
  url: 'http://192.168.1.5:4567',
  username: 'reader',
  has_password: true,
  password_readable: true,
};

describe('Suwayomi server settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSuwayomiSettings.mockResolvedValue(null);
    testSuwayomiConnection.mockResolvedValue({ name: 'Suwayomi', version: 'v2.4', sources: 12 });
  });

  it('connects to the local default server and reports what it found', async () => {
    const user = userEvent.setup();
    saveSuwayomiSettings.mockResolvedValue({
      enabled: true,
      url: 'http://127.0.0.1:4567',
      username: null,
      has_password: false,
      password_readable: true,
    });
    render(<SuwayomiServer />);

    expect(await screen.findByLabelText('Server address')).toHaveValue('http://127.0.0.1:4567');
    // No password field until a username is entered.
    expect(screen.queryByLabelText('Password')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(saveSuwayomiSettings).toHaveBeenCalledWith({
        enabled: true,
        url: 'http://127.0.0.1:4567',
        username: null,
      }),
    );
    await screen.findByText('Saved. Connected to Suwayomi v2.4: 12 sources.');
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['sources'] });
  });

  it('sends the password once, then empties the field', async () => {
    const user = userEvent.setup();
    saveSuwayomiSettings.mockResolvedValue(savedWithPassword);
    render(<SuwayomiServer />);

    const address = await screen.findByLabelText('Server address');
    await user.clear(address);
    await user.type(address, 'http://192.168.1.5:4567');
    await user.type(screen.getByLabelText('Username (optional)'), 'reader');
    await user.type(screen.getByLabelText('Password'), PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(saveSuwayomiSettings).toHaveBeenCalledWith({
        enabled: true,
        url: 'http://192.168.1.5:4567',
        username: 'reader',
        password: PASSWORD,
      }),
    );
    await screen.findByText(/Saved\. Connected/);
    expect(screen.getByLabelText('Password')).toHaveValue('');
    expect(screen.getByLabelText('Password')).toHaveAttribute(
      'placeholder',
      'A password is saved. Type a new one to replace it',
    );
    expect(document.body.textContent).not.toContain(PASSWORD);
  });

  it('keeps the saved password by leaving it out, and says when the server is down', async () => {
    const user = userEvent.setup();
    getSuwayomiSettings.mockResolvedValue(savedWithPassword);
    saveSuwayomiSettings.mockResolvedValue(savedWithPassword);
    testSuwayomiConnection.mockRejectedValue(new Error('The Suwayomi server is not reachable'));
    render(<SuwayomiServer />);

    expect(await screen.findByLabelText('Password')).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(saveSuwayomiSettings).toHaveBeenCalledWith({
        enabled: true,
        url: 'http://192.168.1.5:4567',
        username: 'reader',
      }),
    );
    await screen.findByText(
      "Saved, but the server didn't answer: The Suwayomi server is not reachable",
    );
  });

  it('imports the server library and says how much is coming', async () => {
    const user = userEvent.setup();
    getSuwayomiSettings.mockResolvedValue(savedWithPassword);
    importSuwayomiLibrary.mockResolvedValue({ id: 'job', titles: 3 });
    render(<SuwayomiServer />);
    await user.click(await screen.findByRole('button', { name: 'Import library' }));
    await screen.findByText(/Importing 3 titles/);
  });

  it('removes the connection', async () => {
    const user = userEvent.setup();
    getSuwayomiSettings.mockResolvedValue(savedWithPassword);
    removeSuwayomiSettings.mockResolvedValue(null);
    render(<SuwayomiServer />);

    await user.click(await screen.findByRole('button', { name: 'Remove server' }));
    await screen.findByText('Removed.');
    expect(screen.getByLabelText('Server address')).toHaveValue('http://127.0.0.1:4567');
    expect(invalidateQueries).toHaveBeenCalled();
  });

  it('explains when the server refuses the settings', async () => {
    getSuwayomiSettings.mockRejectedValue(new Error('Forbidden'));
    render(<SuwayomiServer />);
    await screen.findByText(/needs administrator access/);
  });
});
