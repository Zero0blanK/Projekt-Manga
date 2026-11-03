import '@testing-library/jest-dom/vitest';
import { vi, afterEach, beforeEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// next/image renders a real <img> under jsdom but pulls in the optimizer's URL builder,
// which needs a Next runtime that doesn't exist here. Rendering it as a plain <img>
// keeps these tests about the component's own behaviour — placeholder, load, error —
// rather than about Next's image pipeline.
vi.mock('next/image', () => ({
  default: ({
    src,
    alt,
    fill: _fill,
    priority: _priority,
    ...rest
  }: Record<string, unknown> & { src: string; alt: string }) => {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={alt} {...(rest as Record<string, unknown>)} />;
  },
  // Cover downloads the URL this returns itself; the source URL stands in for the optimizer's.
  getImageProps: ({ src }: { src: string }) => ({ props: { src } }),
}));

// Cover fetches its image to show download progress. jsdom has no blob URLs and nothing
// answers fetch, so every test gets a small image back; a test can stub its own instead.
beforeEach(() => {
  let next = 0;
  // Assigned rather than vi.stubGlobal: unstubbing would also drop the globals some test
  // files stub once at module level (IntersectionObserver).
  globalThis.fetch = vi.fn(
    async () =>
      new Response(new Uint8Array([1, 2, 3, 4]), {
        headers: { 'content-type': 'image/webp', 'content-length': '4' },
      }),
  );
  URL.createObjectURL = () => `blob:test-${next++}`;
  URL.revokeObjectURL = () => {};
});

afterEach(() => {
  cleanup();
});
