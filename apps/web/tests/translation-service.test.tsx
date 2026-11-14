import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const getTranslateSettings = vi.fn();
const getTranslateStatus = vi.fn();
const saveTranslateSettings = vi.fn();
const removeTranslateSettings = vi.fn();

vi.mock('@projekt-manga/api-client', () => ({
  getTranslateSettings: (...args: unknown[]) => getTranslateSettings(...args),
  getTranslateStatus: (...args: unknown[]) => getTranslateStatus(...args),
  saveTranslateSettings: (...args: unknown[]) => saveTranslateSettings(...args),
  removeTranslateSettings: (...args: unknown[]) => removeTranslateSettings(...args),
  // A server from before local translation: the card stays hidden.
  getLocalTranslationStatus: vi.fn(async () => ({ enabled: false })),
  downloadLocalTranslation: vi.fn(),
}));
vi.mock('@/lib/page-translation', () => ({ forgetTranslationStatus: vi.fn() }));

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
});
