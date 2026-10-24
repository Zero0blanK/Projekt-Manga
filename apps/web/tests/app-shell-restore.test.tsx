import { useEffect, useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

const { restore, unmountReader, push, replace, route } = vi.hoisted(() => ({
  restore: { pending: false },
  unmountReader: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
  route: { pathname: '/history' },
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace }),
  usePathname: () => route.pathname,
}));
vi.mock('@/lib/restore-job', () => ({ useRestorePending: () => restore.pending }));
vi.mock('@/lib/library-store', () => ({ useMangaLibrary: () => ({ loading: false }) }));
vi.mock('@/lib/use-app-ready', () => ({
  useDocumentReady: () => true,
  useDesktopInitReady: () => true,
}));
vi.mock('@/lib/startup-static-data', () => ({ useWarmStartupStaticData: () => true }));
vi.mock('@/lib/app-store', () => ({ useSetting: (_key: string, fallback: unknown) => fallback }));
vi.mock('@/lib/theme', () => ({
  applyAppearance: vi.fn(),
  DEFAULT_ACCENT: '',
  DEFAULT_THEME: '',
  DEFAULT_UI_SCALE: '',
}));
vi.mock('@/components/floating-nav', () => ({ FloatingNav: () => null }));
vi.mock('@/components/ui/toaster', () => ({ Toaster: () => null }));
vi.mock('@/components/splash-intro', () => ({ SplashIntro: () => null }));
vi.mock('@/components/automatic-library-updates', () => ({
  AutomaticLibraryUpdates: ({ suspended }: { suspended: boolean }) => (
    <span data-testid="library-suspended">{String(suspended)}</span>
  ),
}));
vi.mock('@/components/automatic-desktop-sync', () => ({
  AutomaticDesktopSync: ({ ready }: { ready: boolean }) => (
    <span data-testid="sync-ready">{String(ready)}</span>
  ),
}));
vi.mock('@/components/restore-job-monitor', () => ({
  RestoreJobMonitor: () => <span>Restore monitor</span>,
}));
vi.mock('@/components/restore-blocking-screen', () => ({
  RestoreBlockingScreen: () => <span>Restore blocker</span>,
}));

import { AppShell } from '@/components/app-shell';

beforeEach(() => {
  restore.pending = false;
  route.pathname = '/history';
  vi.clearAllMocks();
});

function Reader() {
  const [page, setPage] = useState(1);
  useEffect(
    () => () => {
      unmountReader();
    },
    [],
  );
  return <button onClick={() => setPage(page + 1)}>Reader page {page}</button>;
}

it('stops mounted route effects during restore and remounts fresh route state after completion', () => {
  const view = render(
    <AppShell>
      <Reader />
    </AppShell>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Reader page 1' }));
  expect(screen.getByRole('button', { name: 'Reader page 2' })).toBeInTheDocument();

  restore.pending = true;
  view.rerender(
    <AppShell>
      <Reader />
    </AppShell>,
  );
  expect(screen.queryByRole('button', { name: /Reader page/ })).not.toBeInTheDocument();
  expect(unmountReader).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Restore monitor')).toBeInTheDocument();
  expect(screen.getByText('Restore blocker')).toBeInTheDocument();
  expect(screen.getByTestId('library-suspended')).toHaveTextContent('true');
  expect(screen.getByTestId('sync-ready')).toHaveTextContent('false');
  fireEvent.keyDown(window, { key: 'g' });
  fireEvent.keyDown(window, { key: 'l' });
  expect(push).not.toHaveBeenCalled();

  restore.pending = false;
  view.rerender(
    <AppShell>
      <Reader />
    </AppShell>,
  );
  expect(screen.getByRole('button', { name: 'Reader page 1' })).toBeInTheDocument();
  expect(screen.getByTestId('library-suspended')).toHaveTextContent('false');
  expect(screen.getByTestId('sync-ready')).toHaveTextContent('true');
});

it.each(['/reader/chapter', '/discover/preview/source/title/read'])(
  'leaves %s after restore without mounting stale reader props',
  (pathname) => {
    route.pathname = pathname;
    restore.pending = true;
    const view = render(
      <AppShell>
        <Reader />
      </AppShell>,
    );
    restore.pending = false;
    view.rerender(
      <AppShell>
        <Reader />
      </AppShell>,
    );
    expect(replace).toHaveBeenCalledWith('/');
    expect(screen.queryByRole('button', { name: /Reader page/ })).not.toBeInTheDocument();
    route.pathname = '/';
    view.rerender(
      <AppShell>
        <span>Restored library</span>
      </AppShell>,
    );
    expect(screen.getByText('Restored library')).toBeInTheDocument();
  },
);
