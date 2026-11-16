import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

const params = vi.hoisted(() => ({ value: { sourceId: 'mangadex', mangaId: 'a/b' } }));
vi.mock('next/navigation', () => ({
  useParams: () => params.value,
  useRouter: () => ({ back: vi.fn(), push: vi.fn() }),
  usePathname: () => '/discover/preview/mangadex/a%2Fb',
}));
vi.mock('@/components/cover', () => ({
  Cover: ({ alt, src }: { alt: string; src: string | null }) => (
    <img alt={alt} src={src ?? undefined} />
  ),
}));

const { SourcePreviewShell, SLOW_DETAILS_MS } =
  await import('@/components/discover/source-preview-shell');
const { clearSourcePreviewSeeds, rememberSourcePreview, sourcePreviewSeed } =
  await import('@/lib/source-preview-seed');

afterEach(() => {
  cleanup();
  clearSourcePreviewSeeds();
});

describe('the source title page while its details load', () => {
  it("shows the card's title and cover at once", () => {
    rememberSourcePreview('mangadex', 'a/b', {
      title: 'Frieren',
      thumbnailUrl: '/api/source/image-proxy?url=x',
    });

    render(<SourcePreviewShell />);

    expect(screen.getByRole('heading', { level: 1, name: 'Frieren' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Frieren' })).toHaveAttribute(
      'src',
      '/api/source/image-proxy?url=x',
    );
    expect(screen.getByRole('status')).toHaveTextContent('Loading details from the source');
  });

  it('is the plain skeleton without a card to go on, still saying it is loading', () => {
    render(<SourcePreviewShell />);
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Loading details from the source');
  });

  it('says the source or connection is slow when the details take a while', () => {
    vi.useFakeTimers();
    try {
      render(<SourcePreviewShell />);
      act(() => vi.advanceTimersByTime(SLOW_DETAILS_MS));
      expect(screen.getByRole('status')).toHaveTextContent('your connection is slow');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the most recent cards and forgets the oldest', () => {
    for (let i = 0; i <= 200; i++) {
      rememberSourcePreview('s', `m${i}`, { title: `T${i}`, thumbnailUrl: null });
    }
    expect(sourcePreviewSeed('s', 'm0')).toBeNull();
    expect(sourcePreviewSeed('s', 'm200')?.title).toBe('T200');
  });
});
