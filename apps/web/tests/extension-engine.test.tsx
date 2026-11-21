import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ExtensionEngineStatus } from '@projekt-manga/api-client';

const api = {
  getSuwayomiSettings: vi.fn(),
  setSuwayomiMode: vi.fn(),
  getExtensionEngine: vi.fn(),
  installExtensionEngine: vi.fn(),
  cancelExtensionEngineDownload: vi.fn(),
  checkExtensionEngineUpdates: vi.fn(),
  updateExtensionEngine: vi.fn(),
  startExtensionEngine: vi.fn(),
  stopExtensionEngine: vi.fn(),
  removeExtensionEngine: vi.fn(),
  saveExtensionEngineSettings: vi.fn(),
  getExtensionEngineRepositories: vi.fn(),
  saveExtensionEngineRepositories: vi.fn(),
};
vi.mock('@projekt-manga/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@projekt-manga/api-client')>();
  return {
    ...actual,
    ...Object.fromEntries(
      Object.entries(api).map(([name, fn]) => [name, (...args: unknown[]) => fn(...args)]),
    ),
  };
});
// "My own Suwayomi server" is its own form, tested on its own.
vi.mock('@/components/settings/suwayomi-server', () => ({
  SuwayomiServer: () => <form aria-label="Suwayomi server" />,
}));

const { ExtensionEngine } = await import('@/components/settings/extension-engine');
const { queryClient } = await import('@/lib/query-client');

const status = (extra: Partial<ExtensionEngineStatus> = {}): ExtensionEngineStatus => ({
  state: 'not-installed',
  supported: true,
  installed: null,
  download: null,
  update: null,
  error: null,
  lastLines: [],
  diskBytes: 0,
  memoryMb: null,
  startWithServer: null,
  licenses: [
    { name: 'Suwayomi-Server', license: 'MPL-2.0', url: 'https://example.test/mpl' },
    {
      name: 'Eclipse Temurin',
      license: 'GPL-2.0 with the Classpath Exception',
      url: 'https://example.test/gpl',
    },
  ],
  ...extra,
});

const installed = (extra: Partial<ExtensionEngineStatus> = {}) =>
  status({
    state: 'running',
    installed: { server: 'v2.4.2366', runtime: 'jdk-21.0.13.1+2' },
    diskBytes: 420 * 1024 * 1024,
    memoryMb: 512,
    startWithServer: true,
    ...extra,
  });

const settings = (mode: 'built-in' | 'external' | 'off', url = '') => ({
  mode,
  enabled: mode !== 'off',
  url,
  username: null,
  has_password: false,
  password_readable: true,
});

beforeEach(() => {
  vi.clearAllMocks();
  queryClient.clear();
  api.getSuwayomiSettings.mockResolvedValue(settings('built-in'));
  api.getExtensionEngineRepositories.mockResolvedValue([]);
});
afterEach(cleanup);

describe('Settings › Extensions › Extension engine', () => {
  it('offers the download with its size and licenses, and starts it', async () => {
    const user = userEvent.setup();
    api.getExtensionEngine.mockResolvedValue(status());
    api.installExtensionEngine.mockResolvedValue(
      status({ state: 'downloading', download: { step: 'runtime', received: 25, total: 100 } }),
    );
    render(<ExtensionEngine />);
    expect(await screen.findByText(/about 235 MB/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Suwayomi-Server' })).toHaveAttribute(
      'href',
      'https://example.test/mpl',
    );
    await user.click(screen.getByRole('button', { name: 'Download' }));
    expect(api.installExtensionEngine).toHaveBeenCalledOnce();
    expect(await screen.findByText('Downloading the Java runtime: 25%')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Extension engine download' })).toHaveAttribute(
      'aria-valuenow',
      '25',
    );
  });

  it('cancels a download in progress', async () => {
    const user = userEvent.setup();
    api.getExtensionEngine.mockResolvedValue(
      status({ state: 'downloading', download: { step: 'server', received: 10, total: 200 } }),
    );
    api.cancelExtensionEngineDownload.mockResolvedValue(status());
    render(<ExtensionEngine />);
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(api.cancelExtensionEngineDownload).toHaveBeenCalledOnce();
    expect(await screen.findByRole('button', { name: 'Download' })).toBeInTheDocument();
  });

  it('says why a download failed', async () => {
    api.getExtensionEngine.mockResolvedValue(
      status({ error: "The download doesn't match its published checksum" }),
    );
    render(<ExtensionEngine />);
    expect(await screen.findByRole('alert')).toHaveTextContent('published checksum');
  });

  it('shows the running engine, stops it, and checks for updates', async () => {
    const user = userEvent.setup();
    api.getExtensionEngine.mockResolvedValue(installed());
    api.checkExtensionEngineUpdates.mockResolvedValue(installed());
    api.stopExtensionEngine.mockResolvedValue(installed({ state: 'stopped' }));
    render(<ExtensionEngine />);
    expect(await screen.findByText('Running')).toBeInTheDocument();
    expect(
      screen.getByText(/engine v2\.4\.2366 · Java jdk-21\.0\.13\.1\+2 · 420 MB on disk/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Check for updates' }));
    expect(await screen.findByText('You have the latest versions.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(await screen.findByRole('button', { name: 'Start' })).toBeInTheDocument();
  });

  it('offers an update that was found, and installs it on request', async () => {
    const user = userEvent.setup();
    api.getExtensionEngine.mockResolvedValue(
      installed({ update: { server: 'v2.5.0', runtime: 'jdk-21.0.14+1' } }),
    );
    api.updateExtensionEngine.mockResolvedValue(
      installed({ state: 'downloading', download: { step: 'server', received: 0, total: 100 } }),
    );
    render(<ExtensionEngine />);
    await user.click(await screen.findByRole('button', { name: 'Update to v2.5.0' }));
    expect(api.updateExtensionEngine).toHaveBeenCalledOnce();
  });

  it('shows the last output when the engine is not working', async () => {
    api.getExtensionEngine.mockResolvedValue(
      installed({
        state: 'error',
        error: 'The engine stopped unexpectedly',
        lastLines: ['line one', 'line two'],
      }),
    );
    render(<ExtensionEngine />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The engine stopped unexpectedly');
    expect(alert).toHaveTextContent('line one');
  });

  it('saves the memory limit and start-with-the-app setting', async () => {
    const user = userEvent.setup();
    api.getExtensionEngine.mockResolvedValue(installed({ state: 'stopped' }));
    api.saveExtensionEngineSettings.mockResolvedValue(
      installed({ state: 'stopped', startWithServer: false }),
    );
    render(<ExtensionEngine />);
    await user.click(await screen.findByRole('switch', { name: 'Start with the app' }));
    expect(api.saveExtensionEngineSettings).toHaveBeenCalledWith({ start_with_server: false });
    await user.click(screen.getByRole('button', { name: /Memory limit/ }));
    await user.click(await screen.findByRole('menuitem', { name: '1024 MB' }));
    expect(api.saveExtensionEngineSettings).toHaveBeenLastCalledWith({ memory_mb: 1024 });
  });

  it('removes the engine after asking, keeping its extensions unless told otherwise', async () => {
    const user = userEvent.setup();
    api.getExtensionEngine.mockResolvedValue(installed({ state: 'stopped' }));
    api.removeExtensionEngine.mockResolvedValue(status());
    render(<ExtensionEngine />);
    await user.click(await screen.findByRole('button', { name: 'Remove engine' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Its extensions and their settings are kept');
    await user.click(within(dialog).getByRole('button', { name: 'Remove engine' }));
    await waitFor(() => expect(api.removeExtensionEngine).toHaveBeenCalledWith(true));
  });

  it('removes its extensions too when that box is ticked', async () => {
    const user = userEvent.setup();
    api.getExtensionEngine.mockResolvedValue(installed({ state: 'stopped' }));
    api.removeExtensionEngine.mockResolvedValue(status());
    render(<ExtensionEngine />);
    await user.click(await screen.findByRole('checkbox', { name: /Also remove its extensions/ }));
    await user.click(screen.getByRole('button', { name: 'Remove engine' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove engine' }),
    );
    await waitFor(() => expect(api.removeExtensionEngine).toHaveBeenCalledWith(false));
  });

  it('adds and removes extension repositories while the engine runs', async () => {
    const user = userEvent.setup();
    api.getExtensionEngine.mockResolvedValue(installed());
    const repo = { url: 'https://repo.example/index.min.json', name: 'Example' };
    api.saveExtensionEngineRepositories.mockResolvedValueOnce([repo]).mockResolvedValueOnce([]);
    render(<ExtensionEngine />);
    expect(await screen.findByText('No repositories yet.')).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Repository URL' }), repo.url);
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(api.saveExtensionEngineRepositories).toHaveBeenCalledWith([repo.url]);
    expect(await screen.findByText('Example')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(api.saveExtensionEngineRepositories).toHaveBeenLastCalledWith([]);
    expect(await screen.findByText('No repositories yet.')).toBeInTheDocument();
  });

  it('switches between the built-in engine, your own server and off', async () => {
    const user = userEvent.setup();
    api.getSuwayomiSettings.mockResolvedValue(settings('off'));
    api.setSuwayomiMode.mockResolvedValue(settings('built-in'));
    api.getExtensionEngine.mockResolvedValue(status());
    render(<ExtensionEngine />);
    expect(await screen.findByText('No Suwayomi sources are shown.')).toBeInTheDocument();
    // Your own server shows its form first; choosing it is saved with the address.
    await user.click(screen.getByRole('radio', { name: 'My own Suwayomi server' }));
    expect(screen.getByRole('form', { name: 'Suwayomi server' })).toBeInTheDocument();
    expect(api.setSuwayomiMode).not.toHaveBeenCalled();
    await user.click(screen.getByRole('radio', { name: 'Built-in engine' }));
    expect(api.setSuwayomiMode).toHaveBeenCalledWith('built-in');
    expect(await screen.findByRole('button', { name: 'Download' })).toBeInTheDocument();
  });

  it('says so when this computer has no Java runtime build', async () => {
    api.getExtensionEngine.mockResolvedValue(status({ supported: false }));
    render(<ExtensionEngine />);
    expect(
      await screen.findByText(/No Java runtime is published for this computer/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull();
  });
});
