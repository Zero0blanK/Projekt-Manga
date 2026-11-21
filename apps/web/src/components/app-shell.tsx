'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { FloatingNav } from '@/components/floating-nav';
import { Toaster } from '@/components/ui/toaster';
import { ConnectionBanner } from '@/components/connection-banner';
import { DownloadDial } from '@/components/downloads/download-dial';
import { SplashIntro } from '@/components/splash-intro';
import { LibraryUpdateDial } from '@/components/library/library-update-dial';
import { useMangaLibrary } from '@/lib/library-store';
import { useDesktopApiStarting, useDesktopInitReady, useDocumentReady } from '@/lib/use-app-ready';
import { queryClient, queryKeys } from '@/lib/query-client';
import { useWarmStartupStaticData } from '@/lib/startup-static-data';
import { useSetting } from '@/lib/app-store';
import {
  applyAppearance,
  DEFAULT_FROST_THEME,
  DEFAULT_INK_THEME,
  DEFAULT_THEME,
  DEFAULT_UI_SCALE,
  DEFAULT_UI_STYLE,
} from '@/lib/theme';
import {
  setPreviousLocation,
  markNavigatedInApp,
  forgetPreviousLocationIfEnteredDirectly,
} from '@/lib/nav-history';
import { AutomaticLibraryUpdates } from '@/components/automatic-library-updates';
import { AutomaticDesktopSync } from '@/components/automatic-desktop-sync';
import { RestoreJobMonitor } from '@/components/restore-job-monitor';
import { useRestorePending } from '@/lib/restore-job';
import { RestoreStatusCard } from '@/components/restore-status-card';
import { CommandPalette } from '@/components/command-palette';
import { updateBridge } from '@/lib/desktop-update';
import { registerServiceWorker } from '@/lib/service-worker';
import dynamic from 'next/dynamic';
import { SmoothScroll } from '@/components/smooth-scroll';
import { useScrollBehavior } from '@/lib/scroll';
import { DesktopIntegration } from '@/components/desktop-integration';
import { ServerStartingScreen } from '@/components/server-starting-screen';

// Desktop only, and with the changelog in it: downloaded only where updates can happen.
const UpdatePrompt = dynamic(
  () => import('@/components/update-prompt').then((m) => m.UpdatePrompt),
  { ssr: false },
);

export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [hasUpdates, setHasUpdates] = useState(false);
  useEffect(() => setHasUpdates(updateBridge() !== null), []);
  // After the page has loaded, so it never competes with the first screen for the network.
  useEffect(() => {
    if (document.readyState === 'complete') {
      void registerServiceWorker();
      return;
    }
    const onLoad = () => void registerServiceWorker();
    window.addEventListener('load', onLoad, { once: true });
    return () => window.removeEventListener('load', onLoad);
  }, []);

  // "Ready" is the document being done (subresources and webfonts) plus the library
  // having answered, since every first screen waits on both. The splash holds until
  // then, so it covers the real load rather than a fixed guess.
  const documentReady = useDocumentReady();
  const { loading: libraryLoading } = useMangaLibrary();
  // Desktop only: the window opens once the web server answers, which can be well before
  // the API does (the first start after an update especially). Requests wait for it in the
  // API client (desktop-api-gate.ts); this keeps the splash up, then a "starting" screen.
  const { starting: apiStarting, startedAt: apiStartedAt } = useDesktopApiStarting();
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

  const smoothScroll = useScrollBehavior() === 'smooth';

  const appReady =
    documentReady && desktopInitReady && !libraryLoading && staticDataReady && !apiStarting;
  const [splashDone, setSplashDone] = useState(false);
  const finishSplash = useCallback(() => setSplashDone(true), []);

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
  // Empty until one is picked: the interface style then supplies its own default.
  const accent = useSetting('accent', '') as string;
  const uiScale = useSetting('uiScale', DEFAULT_UI_SCALE) as string;
  const reduceMotion = useSetting('reduceMotion', false) as boolean;
  const uiStyle = useSetting('uiStyle', DEFAULT_UI_STYLE) as string;
  const frostTheme = useSetting('frostTheme', DEFAULT_FROST_THEME) as string;
  const frostGlass = useSetting('frostGlass', true) as boolean;
  const inkTheme = useSetting('inkTheme', DEFAULT_INK_THEME) as string;
  const inkTone = useSetting('inkTone', true) as boolean;

  // Settings > Appearance. The same values are already on <html> from the blocking init
  // script in the layout; this re-applies them when they change at runtime, and keeps
  // "Auto" in sync if the OS preference flips while the app is open.
  useEffect(() => {
    const apply = () =>
      applyAppearance({
        theme,
        accent: accent || undefined,
        uiScale,
        reduceMotion,
        uiStyle,
        frostTheme,
        frostGlass,
        inkTheme,
        inkTone,
      });
    apply();
    const palette = uiStyle === 'frost' ? frostTheme : uiStyle === 'ink' ? inkTheme : theme;
    if (String(palette).toLowerCase() !== 'auto') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme, accent, uiScale, reduceMotion, uiStyle, frostTheme, frostGlass, inkTheme, inkTone]);

  // Global shortcuts: "g" then l/d/h/s jumps between sections.
  useEffect(() => {
    let pendingG = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onKey = (e: KeyboardEvent) => {
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
          h: '/history',
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
  }, [router]);

  return (
    <div data-slot="app-page" className="min-h-screen w-full bg-background">
      {/* Always rendered, not gated behind client-only state, so its markup is part of the
          server-rendered HTML. It decides for itself whether this session skips straight
          through; see splash-intro.tsx and lib/splash.ts. */}
      <SplashIntro ready={appReady} onFinish={finishSplash} />
      <AutomaticLibraryUpdates suspended={restorePending} />
      <AutomaticDesktopSync ready={appReady && !restorePending} />
      <CommandPalette />
      {/* The reader smooths its own strip; every other screen scrolls the page. */}
      {smoothScroll && !isReaderPath && <SmoothScroll />}
      <DesktopIntegration />
      <RestoreJobMonitor />
      {/* A restore runs in the background: the app stays usable, and reading done meanwhile
          is kept (lib/restore-job.ts, the desktop's reconcile). Library updates and desktop
          sync wait for it above, since the restore holds the database's write lock. */}
      <RestoreStatusCard />
      <div>
        <FloatingNav />
        <main className="min-w-0 pt-24">{children}</main>
      </div>
      {/* Only once the splash has gone: it covers the prompt, and the click that skips it
          would otherwise land outside the prompt. Not during a restore: installing restarts
          the app's server, which would roll the restore back to run again. */}
      {splashDone && !restorePending && hasUpdates && <UpdatePrompt />}
      <div className="pointer-events-none fixed bottom-4 right-4 z-40 flex max-w-[calc(100vw-2rem)] flex-col items-end gap-2">
        <LibraryUpdateDial />
        {/* The reader stays clear, and the downloads page already shows the queue. */}
        {!isReaderPath && !pathname.startsWith('/downloads') && <DownloadDial />}
      </div>
      {!isReaderPath && <ConnectionBanner />}
      <Toaster />
      {/* Not tied to the splash: it is often skipped (turned off, or already shown within
          the last 12 hours, which covers the restart after an update). When it does play,
          it sits above this screen and this one is what remains if the API is still loading. */}
      {apiStarting && <ServerStartingScreen startedAt={apiStartedAt} />}
    </div>
  );
}
