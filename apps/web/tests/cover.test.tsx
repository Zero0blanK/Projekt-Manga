import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { Cover } from '@/components/cover';

vi.mock('@/components/discover/content-privacy', () => ({
  useContentPrivacy: () => [{ blurAdult: false }],
  isAdultSource: () => false,
}));
vi.mock('@/lib/extensions-store', () => ({ useInstalledExtensions: () => ({ installed: [] }) }));
vi.mock('@/lib/library-store', () => ({ useSources: () => ({ sources: [] }) }));

/**
 * The placeholder rules matter more than they look: a cover that silently renders a
 * broken image, or a generated colour that reads as real art, both make a missing
 * thumbnail impossible to spot in a grid of a hundred titles.
 */
describe('Cover', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it('shows the placeholder when there is no cover URL', () => {
    render(<Cover src={null} alt="No cover" />);

    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('renders the image when given a URL', () => {
    render(<Cover src="http://localhost:4000/api/source/image-proxy?url=x" alt="One Piece" />);

    const img = screen.getByRole('img', { name: 'One Piece' });
    expect(img).toHaveAttribute('src', expect.stringContaining('image-proxy'));
  });

  it('retries a failed image automatically with a fresh optimizer URL', () => {
    render(<Cover src="http://localhost:4000/api/source/image-proxy?url=gone" alt="Broken" />);

    fireEvent.error(screen.getByRole('img', { name: 'Broken' }));
    act(() => vi.advanceTimersByTime(2_500));
    expect(screen.getByRole('img', { name: 'Broken' })).toHaveAttribute(
      'src',
      expect.stringContaining('_pm_retry='),
    );
  });

  it('resets its failed state when the src changes, so a new cover is retried', () => {
    const { rerender } = render(<Cover src="http://localhost:4000/a" alt="First" />);
    fireEvent.error(screen.getByRole('img', { name: 'First' }));
    act(() => vi.advanceTimersByTime(2_500));

    rerender(<Cover src="http://localhost:4000/b" alt="Second" />);

    // Without the reset, one broken URL would poison the slot for every title that
    // later reuses this component instance in a virtualised list.
    expect(screen.getByRole('img', { name: 'Second' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Second' })).toHaveAttribute(
      'src',
      'http://localhost:4000/b',
    );
  });

  it('retries other failed covers when one image from the same source recovers', () => {
    const first =
      'http://localhost:4000/api/source/image-proxy?url=https%3A%2F%2Fimg.example%2Fa.jpg&source_id=mangageko';
    const second =
      'http://localhost:4000/api/source/image-proxy?url=https%3A%2F%2Fimg.example%2Fb.jpg&source_id=mangageko';
    render(
      <>
        <Cover src={first} alt="First" />
        <Cover src={second} alt="Second" />
      </>,
    );
    fireEvent.error(screen.getByRole('img', { name: 'First' }));
    fireEvent.error(screen.getByRole('img', { name: 'Second' }));
    act(() => vi.advanceTimersByTime(2_500));
    const beforeRecovery = screen.getByRole('img', { name: 'Second' }).getAttribute('src');
    fireEvent.load(screen.getByRole('img', { name: 'First' }));
    act(() => vi.advanceTimersByTime(1_100));
    expect(screen.getByRole('img', { name: 'Second' }).getAttribute('src')).not.toBe(
      beforeRecovery,
    );
  });

  it('revives a cover that exhausted its retries after another cover recovers', () => {
    const first =
      'http://localhost:4000/api/source/image-proxy?url=https%3A%2F%2Fimg.example%2Fa.jpg&source_id=mangageko';
    const second =
      'http://localhost:4000/api/source/image-proxy?url=https%3A%2F%2Fimg.example%2Fb.jpg&source_id=mangageko';
    render(
      <>
        <Cover src={first} alt="First" />
        <Cover src={second} alt="Second" />
      </>,
    );
    for (let retry = 0; retry < 4; retry += 1) {
      fireEvent.error(screen.getByRole('img', { name: 'Second' }));
      act(() => vi.advanceTimersByTime(21_000));
    }
    fireEvent.error(screen.getByRole('img', { name: 'Second' }));
    expect(screen.queryByRole('img', { name: 'Second' })).not.toBeInTheDocument();

    fireEvent.error(screen.getByRole('img', { name: 'First' }));
    act(() => vi.advanceTimersByTime(2_500));
    fireEvent.load(screen.getByRole('img', { name: 'First' }));
    act(() => vi.advanceTimersByTime(1_100));

    expect(screen.getByRole('img', { name: 'Second' })).toHaveAttribute(
      'src',
      expect.stringContaining('_pm_retry='),
    );
  });

  it('stays transparent until the image reports it has loaded', () => {
    render(<Cover src="http://localhost:4000/a" alt="Loading" />);
    const img = screen.getByRole('img', { name: 'Loading' });

    expect(img.className).toContain('opacity-0');
    fireEvent.load(img);
    expect(img.className).toContain('opacity-100');
  });
});
