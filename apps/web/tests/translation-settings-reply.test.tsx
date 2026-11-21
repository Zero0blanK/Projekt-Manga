import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { normalizeTranslateSettings } from '@projekt-manga/api-client';
import { TranslationService } from '@/components/settings/translation-service';

/**
 * The real api-client runs here: only fetch is replaced, so the reply goes through the
 * same reading the Settings page uses. A server that answers without a provider this
 * app knows must leave the panel in its empty state, not take Settings down.
 */
const fetchMock = vi.fn();

const envelope = (data: unknown) =>
  new Response(JSON.stringify({ success: true, message: 'ok', data }), {
    headers: { 'content-type': 'application/json' },
  });

const serve = (settings: unknown) =>
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/translate/settings')) return envelope(settings);
    if (url.includes('/translate/status'))
      return envelope({ enabled: false, server_configured: false, provider: null });
    if (url.includes('/translate/local')) return envelope({ enabled: false });
    return envelope(null);
  });

describe('translation settings reply', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['an empty reply', {}],
    ['a reply without a provider', { url: null, has_key: false, key_readable: true }],
    ['an unknown provider', { provider: 'babelfish', url: null, has_key: true }],
  ])('shows the empty state for %s', async (_name, reply) => {
    serve(reply);
    render(<TranslationService />);
    expect(await screen.findByText(/No translation service yet/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'DeepL' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByRole('button', { name: 'Remove service' })).not.toBeInTheDocument();
  });

  it('still shows a saved service', async () => {
    serve({
      provider: 'libretranslate',
      url: 'http://localhost:5000',
      has_key: false,
      key_readable: true,
      updated_at: '2026-01-01T00:00:00.000Z',
    });
    render(<TranslationService />);
    expect(await screen.findByText(/your LibreTranslate service/)).toBeInTheDocument();
    expect(screen.getByLabelText('Service address')).toHaveValue('http://localhost:5000');
  });
});

describe('normalizeTranslateSettings', () => {
  it('reads anything without a known provider as no service', () => {
    expect(normalizeTranslateSettings(null)).toBeNull();
    expect(normalizeTranslateSettings('deepl')).toBeNull();
    expect(normalizeTranslateSettings({})).toBeNull();
    expect(normalizeTranslateSettings({ provider: 'other' })).toBeNull();
  });

  it('fills in optional fields that are missing', () => {
    expect(normalizeTranslateSettings({ provider: 'deepl' })).toEqual({
      provider: 'deepl',
      url: null,
      has_key: false,
      key_readable: true,
      updated_at: '',
    });
  });
});
