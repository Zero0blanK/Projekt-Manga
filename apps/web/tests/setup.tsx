import '@testing-library/jest-dom/vitest';
import { vi, afterEach } from 'vitest';
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
}));

afterEach(() => {
  cleanup();
});
