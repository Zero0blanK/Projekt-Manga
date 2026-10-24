import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CoverPrivacyProvider } from '@/components/discover/cover-privacy-provider';
import { Cover } from '@/components/cover';

const preferences = vi.hoisted(() => ({ blurAdult: false }));
vi.mock('@/components/discover/content-privacy', () => ({
  useContentPrivacy: () => [preferences],
  isAdultSource: (rating: string | null, fallback: boolean) =>
    rating === 'nsfw' || (!rating && fallback),
}));
vi.mock('@/lib/library-store', () => ({
  useMangaLibrary: () => ({ manga: [] }),
  useSources: () => ({
    sources: [
      { id: 'adult', isNSFW: true },
      { id: 'mixed', isNSFW: true },
      { id: 'builtin', isNSFW: true },
    ],
  }),
}));
vi.mock('@/lib/extensions-store', () => ({
  useInstalledExtensions: () => ({
    installed: [
      { source_key: 'adult', content_rating: 'nsfw', is_nsfw: true },
      { source_key: 'mixed', content_rating: 'mixed', is_nsfw: true },
    ],
  }),
}));
afterEach(() => {
  preferences.blurAdult = false;
});

describe('cover privacy policy', () => {
  it('keeps adult covers visible by default', () => {
    render(
      <CoverPrivacyProvider>
        <Cover src="/cover.png" sourceId="adult" alt="Adult title" />
      </CoverPrivacyProvider>,
    );
    expect(screen.getByRole('img', { name: 'Adult title' })).not.toHaveClass('blur-xl');
  });
  it('blurs adult-only and legacy adult sources while preserving mixed catalogues', () => {
    preferences.blurAdult = true;
    render(
      <CoverPrivacyProvider>
        <Cover src="/a.png" sourceId="adult" alt="Adult" />
        <Cover src="/b.png" sourceId="builtin" alt="Legacy" />
        <Cover src="/c.png" sourceId="mixed" alt="Mixed" />
      </CoverPrivacyProvider>,
    );
    expect(screen.getByRole('img', { name: 'Adult cover hidden: Adult' })).toHaveClass('blur-xl');
    expect(screen.getByRole('img', { name: 'Adult cover hidden: Legacy' })).toHaveClass('blur-xl');
    expect(screen.getByRole('img', { name: 'Mixed' })).not.toHaveClass('blur-xl');
  });
  it('updates already-mounted covers when privacy is disabled', () => {
    preferences.blurAdult = true;
    const { rerender } = render(
      <CoverPrivacyProvider>
        <Cover src="/a.png" sourceId="adult" alt="Adult" />
      </CoverPrivacyProvider>,
    );
    preferences.blurAdult = false;
    rerender(
      <CoverPrivacyProvider>
        <Cover src="/a.png" sourceId="adult" alt="Adult" />
      </CoverPrivacyProvider>,
    );
    expect(screen.getByRole('img', { name: 'Adult' })).not.toHaveClass('blur-xl');
  });
});
