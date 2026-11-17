import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

// A stand-in for Lenis that records what the page asks of it.
const lenis = vi.hoisted(() => ({
  instances: [] as Array<{
    options: Record<string, unknown>;
    stopped: boolean;
    destroyed: boolean;
  }>,
}));
vi.mock('lenis', () => ({
  default: class {
    options: Record<string, unknown>;
    stopped = false;
    destroyed = false;
    constructor(options: Record<string, unknown>) {
      this.options = options;
      lenis.instances.push(this as never);
    }
    stop() {
      this.stopped = true;
    }
    start() {
      this.stopped = false;
    }
    destroy() {
      this.destroyed = true;
    }
  },
}));

const { SmoothScroll } = await import('@/components/smooth-scroll');
const { SCROLL_LOCK_ATTRIBUTE, keepsNativeScroll } = await import('@/lib/smooth-scroll');

afterEach(() => {
  cleanup();
  lenis.instances.length = 0;
  document.body.removeAttribute(SCROLL_LOCK_ATTRIBUTE);
  document.body.innerHTML = '';
});

const flushMutations = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('smooth page scrolling', () => {
  it('smooths the page wheel, leaving touch and nested scroll areas native', () => {
    render(<SmoothScroll />);

    expect(lenis.instances).toHaveLength(1);
    const { options } = lenis.instances[0];
    // No wrapper: Lenis scrolls the window.
    expect(options.wrapper).toBeUndefined();
    expect(options.syncTouch).toBe(false);
    expect(options.allowNestedScroll).toBe(true);
    expect(options.stopInertiaOnNavigate).toBe(true);
    expect(options.respectReducedMotion).toBe(true);
  });

  it('pauses while a dialog locks the page, and resumes after', async () => {
    render(<SmoothScroll />);
    const [instance] = lenis.instances;

    document.body.setAttribute(SCROLL_LOCK_ATTRIBUTE, '1');
    await flushMutations();
    expect(instance.stopped).toBe(true);

    document.body.removeAttribute(SCROLL_LOCK_ATTRIBUTE);
    await flushMutations();
    expect(instance.stopped).toBe(false);
  });

  it('is removed when unmounted', () => {
    const { unmount } = render(<SmoothScroll />);
    unmount();
    expect(lenis.instances[0].destroyed).toBe(true);
  });

  it('leaves dialogs, menus and marked areas to scroll themselves', () => {
    document.body.innerHTML = `
      <div role="dialog"><p id="in-dialog"></p></div>
      <div role="menu"><p id="in-menu"></p></div>
      <div data-lenis-prevent><p id="marked"></p></div>
      <main><p id="page"></p></main>`;
    const node = (id: string) => document.getElementById(id) as HTMLElement;

    expect(keepsNativeScroll(node('in-dialog'))).toBe(true);
    expect(keepsNativeScroll(node('in-menu'))).toBe(true);
    expect(keepsNativeScroll(node('marked'))).toBe(true);
    expect(keepsNativeScroll(node('page'))).toBe(false);
  });
});
