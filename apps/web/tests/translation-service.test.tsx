import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const getTranslateSettings = vi.fn();
const getTranslateStatus = vi.fn();
const saveTranslateSettings = vi.fn();
const removeTranslateSettings = vi.fn();
const getLocalTranslationStatus = vi.fn();
const removeLocalTranslation = vi.fn();

vi.mock('@projekt-manga/api-client', () => ({
  getTranslateSettings: (...args: unknown[]) => getTranslateSettings(...args),
  getTranslateStatus: (...args: unknown[]) => getTranslateStatus(...args),
  saveTranslateSettings: (...args: unknown[]) => saveTranslateSettings(...args),
  removeTranslateSettings: (...args: unknown[]) => removeTranslateSettings(...args),
  getLocalTranslationStatus: (...args: unknown[]) => getLocalTranslationStatus(...args),
  removeLocalTranslation: (...args: unknown[]) => removeLocalTranslation(...args),
  downloadLocalTranslation: vi.fn(),
}));
vi.mock('@/lib/page-translation', () => ({
  forgetTranslationStatus: vi.fn(),
  forgetLocalModels: vi.fn(),
}));

const { TranslationService } = await import('@/components/settings/translation-service');

const KEY = 'my-deepl-key-1234567890:fx';
const status = {
  enabled: false,
  provider: null,
  origin: null,
  server_configured: false,
  source: 'ja',
};

describe('translation service settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getTranslateSettings.mockResolvedValue(null);
    getTranslateStatus.mockResolvedValue(status);
    // A server from before local translation: the card stays hidden.
    getLocalTranslationStatus.mockResolvedValue({ enabled: false });
  });

  it('sends the key once, then empties the field and shows only that a key is saved', async () => {
    const user = userEvent.setup();
    saveTranslateSettings.mockResolvedValue({
      provider: 'deepl',
      url: null,
      has_key: true,
      key_readable: true,
      updated_at: '2026-11-01T00:00:00.000Z',
    });
    render(<TranslationService />);

    const field = await screen.findByLabelText('API key');
    expect(field).toHaveAttribute('type', 'password');
    await user.type(field, KEY);
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(saveTranslateSettings).toHaveBeenCalledWith({ provider: 'deepl', api_key: KEY }),
    );
    await screen.findByText('Saved.');
    expect(screen.getByLabelText('API key')).toHaveValue('');
    expect(screen.getByLabelText('API key')).toHaveAttribute(
      'placeholder',
      'A key is saved. Type a new one to replace it',
    );
    expect(document.body.textContent).not.toContain(KEY);
  });

  it('keeps the saved key by leaving it out of the next save', async () => {
    const user = userEvent.setup();
    const saved = {
      provider: 'libretranslate',
      url: 'http://localhost:5000',
      has_key: true,
      key_readable: true,
      updated_at: '2026-11-01T00:00:00.000Z',
    };
    getTranslateSettings.mockResolvedValue(saved);
    saveTranslateSettings.mockResolvedValue(saved);
    render(<TranslationService />);

    expect(await screen.findByLabelText('API key (optional)')).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(saveTranslateSettings).toHaveBeenCalledWith({
        provider: 'libretranslate',
        url: 'http://localhost:5000',
      }),
    );
  });

  it('tells the reader to enter a key again when the saved one can no longer be read', async () => {
    getTranslateSettings.mockResolvedValue({
      provider: 'deepl',
      url: null,
      has_key: true,
      key_readable: false,
      updated_at: '2026-11-01T00:00:00.000Z',
    });
    render(<TranslationService />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter it again');
  });

  it('removes the translation models after asking, and offers to download them again', async () => {
    const user = userEvent.setup();
    const ready = { enabled: true, state: 'ready', size: 275_000_000, targets: ['en'] };
    getLocalTranslationStatus.mockResolvedValue(ready);
    removeLocalTranslation.mockResolvedValue({ ...ready, state: 'missing' });
    render(<TranslationService />);

    await user.click(await screen.findByRole('button', { name: 'Remove' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('about 275 MB');
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(removeLocalTranslation).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('button', { name: 'Download (275 MB)' })).toBeInTheDocument();
  });
});
