import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { Cover } from '@/components/cover';

vi.mock('@/components/discover/content-privacy', () => ({
  useContentPrivacy: () => [{ blurAdult: false }],
  isAdultSource: () => false,
}));
vi.mock('@/lib/extensions-store', () => ({ useInstalledExtensions: () => ({ installed: [] }) }));
vi.mock('@/lib/library-store', () => ({ useSources: () => ({ sources: [] }) }));

/** Lets the cover's download (fetch, stream reads, blob URL) run to the end. */
async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  });
}

/** The cover each <img> was downloaded from: its src is a blob URL. */
const downloadedFrom = (name: string) =>
  screen.getByRole('img', { name }).getAttribute('data-src') ?? '';

const fetchMock = vi.fn();

/**
 * The placeholder rules matter more than they look: a cover that silently renders a
 * broken image, or a generated colour that reads as real art, both make a missing
 * thumbnail impossible to spot in a grid of a hundred titles.
 */
describe('Cover', () => {
  beforeEach(() => {
    // setImmediate stays real so flush() can wait out the download.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset().mockImplementation(
      async () =>
        new Response(new Uint8Array([1, 2, 3, 4]), {
          headers: { 'content-type': 'image/webp', 'content-length': '4' },
        }),
    );
  });
  afterEach(() => vi.useRealTimers());

  it('shows the placeholder when there is no cover URL', () => {
    render(<Cover src={null} alt="No cover" />);

    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows a progress ring while the cover downloads, then the image', async () => {
    let push!: (chunk: Uint8Array) => void;
    let end!: () => void;
    fetchMock.mockImplementationOnce(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          push = (chunk) => controller.enqueue(chunk);
          end = () => controller.close();
        },
      });
      return new Response(body, { headers: { 'content-length': '10' } });
    });
    render(<Cover src="http://localhost:4000/api/source/image-proxy?url=x" alt="One Piece" />);
    await flush();

    const ring = screen.getByRole('progressbar', { name: 'Loading cover' });
    expect(ring).toHaveAttribute('aria-valuenow', '0');
    push(new Uint8Array(4));
    await flush();
    expect(ring).toHaveAttribute('aria-valuenow', '40');

    push(new Uint8Array(6));
    end();
    await flush();
    const img = screen.getByRole('img', { name: 'One Piece' });
    expect(img).toHaveAttribute('src', expect.stringMatching(/^blob:/));
    expect(fetchMock.mock.calls[0][0]).toContain('image-proxy');

    fireEvent.load(img);
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('still advances with each kilobyte when the server sends no size', async () => {
    let push!: (bytes: Uint8Array) => void;
    fetchMock.mockImplementationOnce(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              push = (bytes) => controller.enqueue(bytes);
            },
          }),
        ),
    );
    render(<Cover src="http://localhost:4000/a" alt="Unknown size" />);
    await flush();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
    push(new Uint8Array(48 * 1024));
    await flush();
    const first = Number(screen.getByRole('progressbar').getAttribute('aria-valuenow'));
    expect(first).toBeGreaterThan(0);
    push(new Uint8Array(96 * 1024));
    await flush();
    const second = Number(screen.getByRole('progressbar').getAttribute('aria-valuenow'));
    expect(second).toBeGreaterThan(first);
    expect(second).toBeLessThan(100);
  });

  it('retries a failed download automatically with a fresh URL', async () => {
    fetchMock.mockImplementationOnce(async () => new Response(null, { status: 502 }));
    render(<Cover src="http://localhost:4000/api/source/image-proxy?url=gone" alt="Broken" />);
    await flush();

    act(() => vi.advanceTimersByTime(2_500));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(downloadedFrom('Broken')).toContain('_pm_retry=');
  });

  it('resets its failed state when the src changes, so a new cover is retried', async () => {
    const { rerender } = render(<Cover src="http://localhost:4000/a" alt="First" />);
    await flush();
    fireEvent.error(screen.getByRole('img', { name: 'First' }));
    act(() => vi.advanceTimersByTime(2_500));

    rerender(<Cover src="http://localhost:4000/b" alt="Second" />);
    await flush();

    // Without the reset, one broken URL would poison the slot for every title that
    // later reuses this component instance in a virtualised list.
    expect(downloadedFrom('Second')).toBe('http://localhost:4000/b');
  });

  it('retries other failed covers when one image from the same source recovers', async () => {
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
    await flush();
    fireEvent.error(screen.getByRole('img', { name: 'First' }));
    fireEvent.error(screen.getByRole('img', { name: 'Second' }));
    act(() => vi.advanceTimersByTime(2_500));
    await flush();
    const beforeRecovery = downloadedFrom('Second');
    fireEvent.load(screen.getByRole('img', { name: 'First' }));
    act(() => vi.advanceTimersByTime(1_100));
    await flush();
    expect(downloadedFrom('Second')).not.toBe(beforeRecovery);
  });

  it('revives a cover that exhausted its retries after another cover recovers', async () => {
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
    await flush();
    for (let retry = 0; retry < 4; retry += 1) {
      fireEvent.error(screen.getByRole('img', { name: 'Second' }));
      act(() => vi.advanceTimersByTime(21_000));
      await flush();
    }
    fireEvent.error(screen.getByRole('img', { name: 'Second' }));
    expect(screen.queryByRole('img', { name: 'Second' })).not.toBeInTheDocument();

    fireEvent.error(screen.getByRole('img', { name: 'First' }));
    act(() => vi.advanceTimersByTime(2_500));
    await flush();
    fireEvent.load(screen.getByRole('img', { name: 'First' }));
    act(() => vi.advanceTimersByTime(1_100));
    await flush();

    expect(downloadedFrom('Second')).toContain('_pm_retry=');
  });

  it('stays transparent until the image reports it has loaded', async () => {
    render(<Cover src="http://localhost:4000/a" alt="Loading" />);
    await flush();
    const img = screen.getByRole('img', { name: 'Loading' });

    expect(img.className).toContain('opacity-0');
    fireEvent.load(img);
    expect(img.className).toContain('opacity-100');
  });
});
