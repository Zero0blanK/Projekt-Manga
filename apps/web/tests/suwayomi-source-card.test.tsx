import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InstalledSourceCard } from '@/components/discover/installed-source-card';

vi.mock('@/lib/source-health-status', () => ({ useSourceHealthStatus: () => 'ok' }));
vi.mock('@/lib/extensions-store', () => ({ extensionActions: { install: vi.fn() } }));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));
vi.mock('@/lib/library-store', () => ({
  useSourceCapabilities: () => ({ capabilities: { latest: true, languageFilter: false } }),
  useSourceFilters: () => ({ filters: [] }),
}));
vi.mock('@/lib/source-display-language', () => ({
  useSourceDisplayLanguage: () => ['all', vi.fn()],
  sourceLanguageFilter: () => null,
}));

afterEach(cleanup);

describe('a Suwayomi source in Discover', () => {
  it('shows its server icon and where it comes from, with no extension record', () => {
    render(
      <InstalledSourceCard
        source={{
          id: 'suwayomi-123',
          name: 'Example',
          lang: 'en',
          base_url: 'https://example.org',
          isNSFW: false,
          provider: 'suwayomi',
          icon_url: 'http://127.0.0.1:4567/api/v1/extension/icon/example.apk',
          accent: '#123456',
        }}
        pinned={false}
        privateReading={false}
        onTogglePin={vi.fn()}
        onToggleIncognito={vi.fn()}
        canMoveUp={false}
        canMoveDown={false}
        onMovePin={vi.fn()}
      />,
    );

    expect(screen.getByText(/Suwayomi/)).toBeInTheDocument();
    expect(screen.queryByText(/Version unavailable/)).toBeNull();
    const icon = document.querySelector('img');
    expect(icon?.getAttribute('src')).toContain('image-proxy');
    expect(decodeURIComponent(icon?.getAttribute('src') ?? '')).toContain(
      'http://127.0.0.1:4567/api/v1/extension/icon/example.apk',
    );
  });
});
