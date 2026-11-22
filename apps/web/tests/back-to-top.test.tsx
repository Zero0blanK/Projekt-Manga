import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Home } from 'lucide-react';

const scrollToTop = vi.fn();
const pathname = vi.hoisted(() => ({ current: '/' }));
vi.mock('@/lib/scroll-to-top', () => ({ scrollToTop: () => scrollToTop() }));
vi.mock('next/navigation', () => ({ usePathname: () => pathname.current }));

const { BackToTop } = await import('@/components/back-to-top');
const { NavButton } = await import('@/components/nav/nav-button');

const scrollTo = (y: number) =>
  act(() => {
    Object.defineProperty(window, 'scrollY', { value: y, configurable: true });
    window.dispatchEvent(new Event('scroll'));
  });

beforeEach(() => {
  scrollToTop.mockClear();
  pathname.current = '/';
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
  Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
});
afterEach(cleanup);

describe('back to top', () => {
  it('appears once the page is scrolled down a screen, and goes back to the top', () => {
    render(<BackToTop />);
    expect(screen.queryByRole('button', { name: 'Back to top' })).toBeNull();
    scrollTo(300);
    expect(screen.queryByRole('button', { name: 'Back to top' })).toBeNull();
    scrollTo(2000);
    fireEvent.click(screen.getByRole('button', { name: 'Back to top' }));
    expect(scrollToTop).toHaveBeenCalledTimes(1);
    scrollTo(0);
    expect(screen.queryByRole('button', { name: 'Back to top' })).toBeNull();
  });
});

describe('the nav item for the current page', () => {
  const item = { label: 'Library', to: '/', icon: Home };

  it('goes back to the top when clicked again on its own page', () => {
    render(<NavButton item={item} active />);
    const link = screen.getByRole('link', { name: 'Library' });
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(scrollToTop).toHaveBeenCalledTimes(1);
  });

  it('still navigates from a page under it, or to another page', () => {
    pathname.current = '/discover/popular';
    render(<NavButton item={{ label: 'Discover', to: '/discover', icon: Home }} active />);
    fireEvent.click(screen.getByRole('link', { name: 'Discover' }));
    expect(scrollToTop).not.toHaveBeenCalled();
  });
});
