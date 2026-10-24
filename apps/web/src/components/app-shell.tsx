'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { FloatingNav } from '@/components/floating-nav';
import { Toaster } from '@/components/ui/toaster';
import { SplashIntro } from '@/components/splash-intro';
import { LibraryUpdateDial } from '@/components/library/library-update-dial';
import { useMangaLibrary } from '@/lib/library-store';
import { useDesktopInitReady, useDocumentReady } from '@/lib/use-app-ready';
import { queryClient, queryKeys } from '@/lib/query-client';
import { useWarmStartupStaticData } from '@/lib/startup-static-data';
import { useSetting } from '@/lib/app-store';
import { applyAppearance, DEFAULT_ACCENT, DEFAULT_THEME, DEFAULT_UI_SCALE } from '@/lib/theme';
import {
  setPreviousLocation,
  markNavigatedInApp,
  forgetPreviousLocationIfEnteredDirectly,
} from '@/lib/nav-history';
import { AutomaticLibraryUpdates } from '@/components/automatic-library-updates';
import { AutomaticDesktopSync } from '@/components/automatic-desktop-sync';
import { RestoreJobMonitor } from '@/components/restore-job-monitor';
import { useRestorePending } from '@/lib/restore-job';
import { RestoreBlockingScreen } from '@/components/restore-blocking-screen';
import { UpdatePrompt } from '@/components/update-prompt';

export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();

  // "Ready" is the document being done (subresources and webfonts) plus the library
  // having answered, since every first screen waits on both. The splash holds until
  // then, so it covers the real load rather than a fixed guess.
  const documentReady = useDocumentReady();
  const { loading: libraryLoading } = useMangaLibrary();
  const staticDataReady = useWarmStartupStaticData();

  /**
   * On desktop, "the library answered" is not the same as "the library is populated".
   *
   * That read comes from a local SQLite file the shell seeds from the API in the
   * background at launch, so it resolves in milliseconds even before the seed has
   * written a row. This waits for the seed when the database started out empty, and
   * refreshes the library when a seed finishes so its rows appear without a navigation.
   * In a plain browser it is always ready.
   */
  const refreshAfterSeed = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.mangaLibrary });
    void queryClient.invalidateQueries({ queryKey: queryKeys.libraryState });
  }, []);
  const desktopInitReady = useDesktopInitReady(refreshAfterSeed);
  const restorePending = useRestorePending();
  const isReaderPath =
    pathname.startsWith('/reader/') ||
    pathname.startsWith('/local-reader/') ||
    (pathname.startsWith('/discover/preview/') && pathname.endsWith('/read'));
  const [restoreReaderPath, setRestoreReaderPath] = useState<string | null>(
    restorePending && isReaderPath ? pathname : null,
  );
  const leavingRestoredReader = restoreReaderPath === pathname;
  useEffect(() => {
    if (restorePending && isReaderPath) setRestoreReaderPath(pathname);
    else if (!restorePending && leavingRestoredReader) router.replace('/');
    else if (restoreReaderPath && restoreReaderPath !== pathname) setRestoreReaderPath(null);
  }, [restorePending, isReaderPath, pathname, leavingRestoredReader, restoreReaderPath, router]);

  const appReady = documentReady && desktopInitReady && !libraryLoading && staticDataReady;

  // Remember where the reader came from, so detail pages can offer a real "back" to the
  // list they were browsing rather than a fixed destination. Detail pages are skipped as
  // an origin — going back from one should land on the list, not the previous title.
  // The query string is read from location rather than useSearchParams(): this component
  // lives in the root layout, where that hook would force a Suspense boundary on every
  // page, and the value is only needed inside this client-side effect anyway.
  const previousHref = useRef<string | null>(null);
  // Runs once, during the first client render and before any child effect reads the
  // stored location (child effects run before this component's own effects).
  useState(() => {
    forgetPreviousLocationIfEnteredDirectly();
    return null;
  });
  useEffect(() => {
    const currentHref = `${window.location.pathname}${window.location.search}`;
    const prior = previousHref.current;
    previousHref.current = currentHref;
    if (!prior || prior === currentHref) return;
    markNavigatedInApp();
    const priorPath = prior.split('?')[0];
    // Detail and reader screens are never a "back" destination — returning from a manga
    // page should land on the list you were browsing, not on the chapter you just read.
    const isTransient =
      priorPath.startsWith('/manga/') ||
      priorPath.startsWith('/reader/') ||
      priorPath.startsWith('/local-reader/') ||
      priorPath.includes('/discover/preview/');
    if (!isTransient) setPreviousLocation(prior);
  }, [pathname]);

  const theme = useSetting('theme', DEFAULT_THEME) as string;
  const accent = useSetting('accent', DEFAULT_ACCENT) as string;
  const uiScale = useSetting('uiScale', DEFAULT_UI_SCALE) as string;
  const reduceMotion = useSetting('reduceMotion', false) as boolean;

  // Settings > Appearance. The same values are already on <html> from the blocking init
  // script in the layout; this re-applies them when they change at runtime, and keeps
  // "Auto" in sync if the OS preference flips while the app is open.
  useEffect(() => {
    const apply = () => applyAppearance({ theme, accent, uiScale, reduceMotion });
    apply();
    if (String(theme).toLowerCase() !== 'auto') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme, accent, uiScale, reduceMotion]);

  // Global shortcuts: "g" then l/d/h/s jumps between sections.
  useEffect(() => {
    let pendingG = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onKey = (e: KeyboardEvent) => {
      if (restorePending) return;
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      const el = e.target as HTMLElement | null;
      if (
        el?.closest(
          'input, textarea, select, button, [contenteditable="true"], [role="dialog"], [role="menu"]',
        )
      )
        return;
      if (pendingG) {
        const map: Record<string, string> = {
          l: '/',
          d: '/discover',
          h: '/recents',
          w: '/downloads',
          b: '/bookmarks',
          s: '/settings',
        };
        const to = map[e.key.toLowerCase()];
        pendingG = false;
        if (to) {
          e.preventDefault();
          router.push(to);
        }
        return;
      }
      if (e.key.toLowerCase() === 'g') {
        pendingG = true;
        clearTimeout(timer);
        timer = setTimeout(() => (pendingG = false), 1200);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      clearTimeout(timer);
    };
  }, [router, restorePending]);

  return (
    <div className="min-h-screen w-full bg-background">
      {/* Always rendered, not gated behind client-only state, so its markup is part of the
          server-rendered HTML. It decides for itself whether this session skips straight
          through; see splash-intro.tsx and lib/splash.ts. */}
      <SplashIntro ready={appReady} />
      <AutomaticLibraryUpdates suspended={restorePending} />
      <AutomaticDesktopSync ready={appReady && !restorePending} />
      <RestoreJobMonitor />
      <RestoreBlockingScreen />
      <div inert={restorePending}>
        <FloatingNav />
        <main className="min-w-0 pt-36 sm:pt-24">
          {/* Reader server props can still contain pre-restore progress. Return to the
              library before mounting a reader that could write that old progress back. */}
          {!restorePending && !leavingRestoredReader && children}
        </main>
      </div>
      {/* After the splash, so the changelog isn't hidden behind it. */}
      {appReady && !restorePending && <UpdatePrompt />}
      <LibraryUpdateDial />
      <Toaster />
    </div>
  );
}
