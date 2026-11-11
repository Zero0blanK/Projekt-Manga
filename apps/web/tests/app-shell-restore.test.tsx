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
  useDesktopApiStarting: () => ({ starting: false, startedAt: null }),
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
vi.mock('@/components/command-palette', () => ({ CommandPalette: () => null }));
vi.mock('@/components/desktop-integration', () => ({ DesktopIntegration: () => null }));
vi.mock('@/components/ui/toaster', () => ({ Toaster: () => null }));
vi.mock('@/components/downloads/download-dial', () => ({ DownloadDial: () => null }));
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
vi.mock('@/components/restore-status-card', () => ({
  RestoreStatusCard: () => <span>Restore status</span>,
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

it('keeps the reader open and usable while a restore runs in the background', () => {
  route.pathname = '/reader/chapter';
  const view = render(
    <AppShell>
      <Reader />
    </AppShell>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Reader page 1' }));

  restore.pending = true;
  view.rerender(
    <AppShell>
      <Reader />
    </AppShell>,
  );
  // Still reading, on the same page, with the restore shown beside it.
  fireEvent.click(screen.getByRole('button', { name: 'Reader page 2' }));
  expect(screen.getByRole('button', { name: 'Reader page 3' })).toBeInTheDocument();
  expect(unmountReader).not.toHaveBeenCalled();
  expect(screen.getByText('Restore status')).toBeInTheDocument();
  expect(screen.getByText('Restore monitor')).toBeInTheDocument();
  // What writes in bulk still waits: the restore holds the database's write lock.
  expect(screen.getByTestId('library-suspended')).toHaveTextContent('true');
  expect(screen.getByTestId('sync-ready')).toHaveTextContent('false');

  restore.pending = false;
  view.rerender(
    <AppShell>
      <Reader />
    </AppShell>,
  );
  // Not sent away from the chapter when it finishes.
  expect(screen.getByRole('button', { name: 'Reader page 3' })).toBeInTheDocument();
  expect(replace).not.toHaveBeenCalled();
  expect(screen.getByTestId('library-suspended')).toHaveTextContent('false');
  expect(screen.getByTestId('sync-ready')).toHaveTextContent('true');
});

it('keeps keyboard shortcuts working during a restore', () => {
  restore.pending = true;
  render(
    <AppShell>
      <span>Library</span>
    </AppShell>,
  );
  fireEvent.keyDown(document.body, { key: 'g' });
  fireEvent.keyDown(document.body, { key: 'd' });
  expect(push).toHaveBeenCalledWith('/discover');
});
