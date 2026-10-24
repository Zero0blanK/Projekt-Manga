import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { pathname, push } = vi.hoisted(() => ({
  pathname: vi.fn<() => string>(),
  push: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: pathname,
  useRouter: () => ({ push }),
}));
vi.mock('@/lib/library-store', () => ({ useMangaLibrary: () => ({ manga: [] }) }));
vi.mock('@/components/nav/nav-notifications', () => ({ NavNotifications: () => null }));
vi.mock('@/components/nav/nav-downloads', () => ({ NavDownloads: () => null }));

const { FloatingNav } = await import('@/components/floating-nav');

describe('floating navigation search', () => {
  it('uses a visible route default but lets readers explicitly change scope', async () => {
    pathname.mockReturnValue('/');
    const view = render(<FloatingNav />);
    expect(screen.getByRole('button', { name: /Search scope: library/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Library' })).toHaveAttribute('aria-current', 'page');

    pathname.mockReturnValue('/discover');
    view.rerender(<FloatingNav />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Search scope: sources/ })).toBeInTheDocument(),
    );
    expect(screen.getByRole('link', { name: 'Discover' })).toHaveAttribute('aria-current', 'page');
    fireEvent.click(screen.getByRole('button', { name: /Search scope: sources/ }));
    expect(screen.getByRole('button', { name: /Search scope: library/ })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Search your library' })).toBeInTheDocument();
  });
});
